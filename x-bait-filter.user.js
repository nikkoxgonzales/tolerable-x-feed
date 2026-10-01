// ==UserScript==
// @name         X Bait Post Filter (Jev)
// @namespace    https://github.com/nikkoxgonzales
// @version      1.1.1
// @description  Hides engagement-bait posts on X/Twitter ("Name one...", "You wake up in 1999...", "Be honest:...") using TypeSafe Jev via OpenRouter.
// @author       nikkoxgonzales
// @homepageURL  https://github.com/nikkoxgonzales/x-bait-filter
// @supportURL   https://github.com/nikkoxgonzales/x-bait-filter/issues
// @downloadURL  https://raw.githubusercontent.com/nikkoxgonzales/x-bait-filter/main/x-bait-filter.user.js
// @updateURL    https://raw.githubusercontent.com/nikkoxgonzales/x-bait-filter/main/x-bait-filter.user.js
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      openrouter.ai
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- config ----------
  const API_URL = 'https://openrouter.ai/api/alpha/decisions';
  const MODEL = 'typesafe/jev-1.13';
  const BATCH_SIZE = 8;          // posts per Jev request (tested: batching does not hurt accuracy)
  const FLUSH_DELAY_MS = 350;    // wait this long to fill a batch while scrolling
  const MAX_IN_FLIGHT = 2;
  const MAX_CHARS = 1000;
  const MIN_CHARS = 8;
  const CACHE_MAX = 4000;

  const settings = {
    apiKey: GM_getValue('apiKey', ''),
    threshold: GM_getValue('threshold', 0.6),
    mode: GM_getValue('mode', 'collapse'),   // 'collapse' | 'hide'
    showScores: GM_getValue('showScores', false),
    enabled: GM_getValue('enabled', true),
  };

  // Few-shot examples, taken from twitter-bait-questions.txt
  const EXAMPLES = [
    'Would you hire a developer who only knows vibe coding?',
    'You wake up in 1999 with a laptop, Wi-Fi, and a coding agent. What do you ship first?',
    'Name one company that has completely lost its vibe',
    'Tell me one thing you can do that CLAUDE cannot do yet',
    'If coding becomes free, what becomes expensive?',
    'Delete one from existence: Stack Overflow, GitHub, VS Code, or Docker.',
    'Be honest: are you using AI to code faster, or using AI because you forgot how to code?',
    "What's a software engineering opinion that would get you ratioed but you still believe?",
  ];

  const question = (key) => ({
    type: 'noul',
    instructions:
      `Is \`${key}\` engagement bait: a generic, open-ended prompt (hypothetical, "name one", ` +
      `"would you rather", "be honest", hot-take poll, "what's the most overrated...") written mainly ` +
      `to farm replies and impressions, in the style of \`examples_of_bait\`?`,
    criteria: {
      true: 'The post is a broad question or prompt aimed at the whole audience to bait replies, opinions, or debate, without sharing real information or asking for specific help.',
      false: 'The post shares news, work, an announcement, a personal update, a joke, or asks a specific, genuine question someone needs answered.',
    },
  });

  // ---------- cache (text hash -> probability) ----------
  let cache = GM_getValue('cache', {});
  let cacheDirty = false;
  function saveCacheSoon() {
    if (cacheDirty) return;
    cacheDirty = true;
    setTimeout(() => {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => cache[a][1] - cache[b][1]);
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
      }
      GM_setValue('cache', cache);
      cacheDirty = false;
    }, 2000);
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36) + ':' + str.length;
  }

  // ---------- styles ----------
  GM_addStyle(`
    .xbf-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 16px; font: 13px/1.4 -apple-system, "Segoe UI", sans-serif;
      color: rgb(113,118,123); border-bottom: 1px solid rgba(113,118,123,.25);
      cursor: default;
    }
    .xbf-bar button {
      margin-left: auto; background: none; border: 1px solid rgba(113,118,123,.5);
      color: inherit; border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit;
    }
    .xbf-bar button:hover { background: rgba(113,118,123,.15); }
    .xbf-bar .xbf-who { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; }
    .xbf-bar .xbf-name { color: rgb(231,233,234); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    .xbf-bar .xbf-check { width: 15px; height: 15px; flex: none; fill: rgb(29,155,240); }
    .xbf-bar .xbf-handle { overflow: hidden; text-overflow: ellipsis; }
    .xbf-bar .xbf-sep { flex: none; }
    .xbf-bar.xbf-open, article.xbf-revealed { background-color: rgba(255,173,31,.07) !important; }
    .xbf-bar.xbf-open { border-bottom: none; color: rgb(255,173,31); }
    @media (prefers-color-scheme: light) { .xbf-bar .xbf-name { color: rgb(15,20,25); } }
    .xbf-score {
      position: absolute; top: 4px; right: 48px; z-index: 2;
      font: 11px monospace; padding: 1px 5px; border-radius: 4px;
      background: rgba(113,118,123,.2); color: rgb(113,118,123); pointer-events: none;
    }
    .xbf-score.xbf-hot { background: rgba(244,33,46,.2); color: rgb(244,33,46); }
  `);

  // ---------- Jev request ----------
  function requestJev(texts) {
    const state = { examples_of_bait: EXAMPLES };
    const questions = {};
    texts.forEach((t, i) => {
      state[`post_${i}`] = t;
      questions[`p${i}`] = question(`post_${i}`);
    });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API_URL,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'X Bait Post Filter',
        },
        data: JSON.stringify({ model: MODEL, state, questions }),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const answers = JSON.parse(res.responseText).answers;
              resolve(texts.map((_, i) => {
                const a = answers[`p${i}`];
                return a && typeof a.noul === 'number' ? a.noul : null;
              }));
            } catch (e) {
              reject(Object.assign(new Error('Bad response: ' + e.message), { retry: false }));
            }
          } else {
            const retry = res.status === 429 || res.status >= 500 || res.status === 402;
            reject(Object.assign(new Error(`Jev ${res.status}: ${res.responseText.slice(0, 300)}`), { retry, status: res.status }));
          }
        },
        onerror: () => reject(Object.assign(new Error('Network error'), { retry: true })),
        ontimeout: () => reject(Object.assign(new Error('Timeout'), { retry: true })),
      });
    });
  }

  // ---------- queue ----------
  const pending = new Map();   // hash -> { text, articles:Set }
  let inFlight = 0;
  let flushTimer = null;
  let authFailed = false;

  function enqueue(h, text, article) {
    let entry = pending.get(h);
    if (!entry) pending.set(h, (entry = { text, articles: new Set(), sent: false }));
    entry.articles.add(article);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DELAY_MS);
  }

  function flush() {
    if (authFailed || !settings.apiKey) return;
    while (inFlight < MAX_IN_FLIGHT) {
      const batch = [];
      for (const [h, e] of pending) {
        if (e.sent) continue;
        e.sent = true;
        batch.push([h, e]);
        if (batch.length >= BATCH_SIZE) break;
      }
      if (!batch.length) return;
      sendBatch(batch, 0);
    }
  }

  async function sendBatch(batch, attempt) {
    inFlight++;
    try {
      const probs = await requestJev(batch.map(([, e]) => e.text));
      batch.forEach(([h, e], i) => {
        pending.delete(h);
        if (probs[i] == null) return;
        cache[h] = [probs[i], Date.now()];
        for (const a of e.articles) if (a.isConnected && a.dataset.xbfHash === h) applyVerdict(a, probs[i]);
      });
      saveCacheSoon();
    } catch (err) {
      console.warn('[x-bait-filter]', err.message);
      if (err.status === 401 || err.status === 403) {
        authFailed = true;
        toast('X Bait Filter: OpenRouter rejected the API key. Set a new one from the Tampermonkey menu.');
      } else if (err.retry && attempt < 3) {
        inFlight--;
        setTimeout(() => sendBatch(batch, attempt + 1), 2000 * 2 ** attempt);
        return;
      } else {
        batch.forEach(([h]) => pending.delete(h));
      }
    }
    inFlight--;
    if (pending.size) scheduleFlush();
  }

  // ---------- DOM ----------
  function getText(article) {
    const el = article.querySelector('[data-testid="tweetText"]');
    return el ? el.innerText.trim().slice(0, MAX_CHARS) : '';
  }

  function applyVerdict(article, p) {
    article.dataset.xbfScore = p.toFixed(2);
    if (settings.showScores) {
      let badge = article.querySelector(':scope > .xbf-score');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'xbf-score';
        if (getComputedStyle(article).position === 'static') article.style.position = 'relative';
        article.prepend(badge);
      }
      badge.textContent = `bait ${p.toFixed(2)}`;
      badge.classList.toggle('xbf-hot', p >= settings.threshold);
    }
    if (p < settings.threshold) return;

    const cell = article.closest('[data-testid="cellInnerDiv"]') || article.parentElement;
    if (settings.mode === 'hide') {
      cell.style.display = 'none';
      cell.dataset.xbfHidden = '1';
      return;
    }
    if (article.previousElementSibling?.classList.contains('xbf-bar')) return;

    const pct = Math.round(p * 100);
    const bar = document.createElement('div');
    bar.className = 'xbf-bar';
    const label = el('span', '', '');
    const btn = el('button', '', '');
    btn.type = 'button';
    bar.append(label, authorInfo(article), btn);

    const setOpen = (open) => {
      article.style.display = open ? '' : 'none';
      article.classList.toggle('xbf-revealed', open);
      bar.classList.toggle('xbf-open', open);
      label.textContent = open ? `Bait post (${pct}%)` : `Bait post hidden (${pct}%)`;
      btn.textContent = open ? 'Hide' : 'Show';
      if (open) article.dataset.xbfRevealed = '1';
      else delete article.dataset.xbfRevealed;
    };
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(!article.dataset.xbfRevealed);
    });
    article.before(bar);
    setOpen(!!article.dataset.xbfRevealed);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // "· Display Name ✓ @handle", read from the post header
  function authorInfo(article) {
    const wrap = el('span', 'xbf-who', '');
    const header = article.querySelector('[data-testid="User-Name"]');
    if (!header) return wrap;
    const handle = [...header.querySelectorAll('span')]
      .map((s) => s.textContent.trim())
      .find((t) => /^@\w+$/.test(t)) || '';
    const nameLink = header.querySelector('a');
    const name = (nameLink ? nameLink.textContent : '').replace(handle, '').trim();
    const verified = !!header.querySelector('[data-testid="icon-verified"]');

    wrap.append(el('span', 'xbf-sep', '·'));
    if (name) wrap.append(el('span', 'xbf-name', name));
    if (verified) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 22 22');
      svg.setAttribute('class', 'xbf-check');
      svg.setAttribute('aria-label', 'Verified');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M20.4 11c0-1.4-.9-2.7-2.1-3.3.5-1.3.2-2.8-.8-3.8s-2.5-1.3-3.8-.8C13.1 1.9 11.9 1 10.5 1S7.9 1.9 7.3 3.1c-1.3-.5-2.8-.2-3.8.8s-1.3 2.5-.8 3.8C1.5 8.3.6 9.6.6 11s.9 2.7 2.1 3.3c-.5 1.3-.2 2.8.8 3.8s2.5 1.3 3.8.8c.6 1.2 1.8 2.1 3.2 2.1s2.6-.9 3.2-2.1c1.3.5 2.8.2 3.8-.8s1.3-2.5.8-3.8c1.3-.6 2.1-1.9 2.1-3.3zm-11 4.6L5.8 12l1.3-1.3 2.3 2.3 5.4-5.6 1.4 1.3-6.8 6.9z');
      svg.append(path);
      wrap.append(svg);
    }
    if (handle) wrap.append(el('span', 'xbf-handle', handle));
    return wrap;
  }

  function resetArticle(article) {
    article.style.display = '';
    article.classList.remove('xbf-revealed');
    delete article.dataset.xbfScore;
    delete article.dataset.xbfRevealed;
    if (article.previousElementSibling?.classList.contains('xbf-bar')) article.previousElementSibling.remove();
    article.querySelector(':scope > .xbf-score')?.remove();
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    if (cell?.dataset.xbfHidden) { cell.style.display = ''; delete cell.dataset.xbfHidden; }
  }

  function processArticle(article) {
    if (!settings.enabled) return;
    const text = getText(article);
    const h = text.length >= MIN_CHARS ? hash(text) : '';
    // X recycles DOM nodes while scrolling, so re-check when the text changes
    if (article.dataset.xbfHash === h) return;
    if (article.dataset.xbfHash !== undefined) resetArticle(article);
    article.dataset.xbfHash = h;
    if (!h) return;
    const hit = cache[h];
    if (hit) applyVerdict(article, hit[0]);
    else enqueue(h, text, article);
  }

  function scan(root = document) {
    root.querySelectorAll('article[data-testid="tweet"]').forEach(processArticle);
  }

  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => { scanQueued = false; scan(); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  function rescanAll() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      resetArticle(a);
      delete a.dataset.xbfHash;
    });
    scan();
  }

  // ---------- UI helpers ----------
  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgb(29,155,240)', color: '#fff', padding: '10px 16px', borderRadius: '8px',
      zIndex: 99999, font: '14px -apple-system, "Segoe UI", sans-serif', maxWidth: '90vw',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  function promptKey() {
    const k = prompt('OpenRouter API key for Jev (stored in Tampermonkey storage):', settings.apiKey);
    if (k === null) return;
    settings.apiKey = k.trim();
    GM_setValue('apiKey', settings.apiKey);
    authFailed = false;
    pending.forEach((e) => { e.sent = false; });
    rescanAll();
    flush();
  }

  GM_registerMenuCommand('Set OpenRouter API key', promptKey);
  GM_registerMenuCommand('Set threshold', () => {
    const v = prompt('Hide posts with bait probability at or above (0-1). Lower = stricter.', settings.threshold);
    const n = parseFloat(v);
    if (v === null || !(n >= 0 && n <= 1)) return;
    settings.threshold = n;
    GM_setValue('threshold', n);
    rescanAll();
  });
  GM_registerMenuCommand('Toggle mode (collapse / hide)', () => {
    settings.mode = settings.mode === 'collapse' ? 'hide' : 'collapse';
    GM_setValue('mode', settings.mode);
    toast(`X Bait Filter: mode = ${settings.mode}`);
    rescanAll();
  });
  GM_registerMenuCommand('Toggle score badges', () => {
    settings.showScores = !settings.showScores;
    GM_setValue('showScores', settings.showScores);
    rescanAll();
  });
  GM_registerMenuCommand('Pause / resume filtering', () => {
    settings.enabled = !settings.enabled;
    GM_setValue('enabled', settings.enabled);
    toast(`X Bait Filter: ${settings.enabled ? 'on' : 'paused'}`);
    rescanAll();
  });
  GM_registerMenuCommand('Clear verdict cache', () => {
    cache = {};
    GM_setValue('cache', cache);
    toast('X Bait Filter: cache cleared');
    rescanAll();
  });

  // ---------- start ----------
  if (!settings.apiKey) {
    toast('X Bait Filter: set your OpenRouter API key from the Tampermonkey menu.');
    setTimeout(promptKey, 500);
  }
  scan();
})();
