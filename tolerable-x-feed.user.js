// ==UserScript==
// @name         Tolerable X Feed
// @namespace    https://github.com/nikkoxgonzales
// @version      2.0.0
// @description  Makes your X/Twitter feed tolerable: hides engagement bait, promo posts and paid ads, using TypeSafe's Jev decision model via OpenRouter.
// @author       nikkoxgonzales
// @homepageURL  https://github.com/nikkoxgonzales/tolerable-x-feed
// @supportURL   https://github.com/nikkoxgonzales/tolerable-x-feed/issues
// @downloadURL  https://raw.githubusercontent.com/nikkoxgonzales/tolerable-x-feed/main/tolerable-x-feed.user.js
// @updateURL    https://raw.githubusercontent.com/nikkoxgonzales/tolerable-x-feed/main/tolerable-x-feed.user.js
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      openrouter.ai
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- config ----------
  const APP = 'Tolerable X Feed';
  const API_URL = 'https://openrouter.ai/api/alpha/decisions';
  const MODEL = 'typesafe/jev-1.13';
  const BATCH_SIZE = 8;          // posts per Jev request (tested: batching does not hurt accuracy)
  const FLUSH_DELAY_MS = 350;    // wait this long to fill a batch while scrolling
  const MAX_IN_FLIGHT = 2;
  const MAX_CHARS = 1000;
  const MIN_CHARS = 8;
  const CACHE_KEY = 'cache_v2';  // bump when the question set changes
  const CACHE_MAX = 4000;

  // Few-shot examples, taken from twitter-bait-questions.txt
  const BAIT_EXAMPLES = [
    'Would you hire a developer who only knows vibe coding?',
    'You wake up in 1999 with a laptop, Wi-Fi, and a coding agent. What do you ship first?',
    'Name one company that has completely lost its vibe',
    'Tell me one thing you can do that CLAUDE cannot do yet',
    'If coding becomes free, what becomes expensive?',
    'Delete one from existence: Stack Overflow, GitHub, VS Code, or Docker.',
    'Be honest: are you using AI to code faster, or using AI because you forgot how to code?',
    "What's a software engineering opinion that would get you ratioed but you still believe?",
  ];

  // Every AI filter is one Jev "noul" (yes/no probability) question per post.
  // All of them are asked for every post so cached scores stay complete when you toggle filters.
  const FILTERS = {
    ad: {
      label: 'Ad',
      desc: 'Paid posts X labels as "Ad". Detected from the page, no AI cost.',
      ai: false,
    },
    bait: {
      label: 'Bait',
      desc: '"Name one…", "You wake up in 1999…", "Be honest:…" reply farming.',
      ai: true,
      question: (k) => ({
        type: 'noul',
        instructions:
          `Is the text of \`${k}\` engagement bait: a generic, open-ended prompt (hypothetical, "name one", ` +
          `"would you rather", "be honest", hot-take poll, "what's the most overrated...") written mainly ` +
          `to farm replies and impressions, in the style of \`examples_of_bait\`?`,
        criteria: {
          true: 'The post is a broad question or prompt aimed at the whole audience to bait replies, opinions, or debate, without sharing real information or asking for specific help.',
          false: 'The post shares news, work, an announcement, a personal update, a joke, or asks a specific, genuine question someone needs answered.',
        },
      }),
    },
    promo: {
      label: 'Promo',
      desc: 'Product launches, pricing, discount codes, webinars, "try it now" links.',
      ai: true,
      question: (k) => ({
        type: 'noul',
        instructions:
          `Is \`${k}\` promotional marketing: the author advertising a product, service, launch, feature release, ` +
          `pricing, sale, discount, course, event signup, or asking for upvotes or purchases? Consider ` +
          `\`${k}.author\` and \`${k}.account\` (a verified organization is a company or brand account).`,
        criteria: {
          true: 'The post sells or promotes something the author or their company offers, such as a product launch, new feature, pricing, discount code, webinar, course, or "try it now" link.',
          false: "The post is news reporting, a personal update, an opinion, a joke, a technical discussion, research, or a question, and is not trying to get the reader to buy, sign up for, or try the author's offering.",
        },
      }),
    },
  };
  const AI_KEYS = Object.keys(FILTERS).filter((k) => FILTERS[k].ai);

  // ---------- settings ----------
  const DEFAULT_FILTERS = { ad: { on: true }, bait: { on: true, threshold: 0.6 }, promo: { on: true, threshold: 0.6 } };
  const savedFilters = GM_getValue('filters', {});
  const settings = {
    apiKey: GM_getValue('apiKey', ''),
    mode: GM_getValue('mode', 'collapse'),   // 'collapse' | 'hide'
    showScores: GM_getValue('showScores', false),
    enabled: GM_getValue('enabled', true),
    filters: Object.fromEntries(Object.keys(FILTERS).map((k) => [k, { ...DEFAULT_FILTERS[k], ...savedFilters[k] }])),
  };
  // carry over the threshold and clean up storage from X Bait Post Filter 1.x
  if (GM_getValue('threshold', null) != null) {
    settings.filters.bait.threshold = GM_getValue('threshold');
    GM_setValue('filters', settings.filters);
    GM_deleteValue('threshold');
    GM_deleteValue('cache');
  }
  let stats = GM_getValue('stats', { posts: 0, cost: 0 });

  // ---------- cache (author+text hash -> {bait, promo}) ----------
  let cache = GM_getValue(CACHE_KEY, {});
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
      GM_setValue(CACHE_KEY, cache);
      GM_setValue('stats', stats);
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
    .txf-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 16px; font: 13px/1.4 -apple-system, "Segoe UI", sans-serif;
      color: rgb(113,118,123); border-bottom: 1px solid rgba(113,118,123,.25);
      cursor: default;
    }
    .txf-bar button {
      margin-left: auto; background: none; border: 1px solid rgba(113,118,123,.5);
      color: inherit; border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit;
    }
    .txf-bar button:hover { background: rgba(113,118,123,.15); }
    .txf-bar .txf-label { flex: none; }
    .txf-bar .txf-who { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; white-space: nowrap; }
    .txf-bar .txf-name { color: rgb(231,233,234); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    .txf-light .txf-bar .txf-name { color: rgb(15,20,25); }
    .txf-bar .txf-check { width: 15px; height: 15px; flex: none; fill: rgb(29,155,240); }
    .txf-bar .txf-check.txf-org { fill: rgb(226,183,25); }
    .txf-bar .txf-handle { overflow: hidden; text-overflow: ellipsis; }
    .txf-bar .txf-sep { flex: none; }
    .txf-bar.txf-open, article.txf-revealed { background-color: rgba(255,173,31,.07) !important; }
    .txf-bar.txf-open { border-bottom: none; color: rgb(255,173,31); }
    .txf-score {
      position: absolute; top: 4px; right: 48px; z-index: 2;
      font: 11px monospace; padding: 1px 5px; border-radius: 4px;
      background: rgba(113,118,123,.2); color: rgb(113,118,123); pointer-events: none;
    }
    .txf-score.txf-hot { background: rgba(244,33,46,.2); color: rgb(244,33,46); }

    .txf-overlay {
      position: fixed; inset: 0; z-index: 100000; background: rgba(91,112,131,.4);
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .txf-panel {
      --bg: rgb(0,0,0); --fg: rgb(231,233,234); --muted: rgb(113,118,123); --line: rgb(47,51,54); --accent: rgb(29,155,240);
      background: var(--bg); color: var(--fg); border-radius: 16px; width: 100%; max-width: 480px;
      max-height: 90vh; overflow: auto; padding: 20px 24px;
      font: 15px/1.4 -apple-system, "Segoe UI", sans-serif; box-shadow: 0 0 15px rgba(255,255,255,.2);
    }
    .txf-light .txf-panel { --bg: #fff; --fg: rgb(15,20,25); --muted: rgb(83,100,113); --line: rgb(239,243,244); box-shadow: 0 0 15px rgba(0,0,0,.2); }
    .txf-panel h2 { margin: 0 0 4px; font-size: 20px; }
    .txf-panel h3 { margin: 18px 0 8px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .txf-panel .txf-sub { color: var(--muted); font-size: 13px; margin: 0; }
    .txf-panel .txf-row { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); }
    .txf-panel .txf-row:first-of-type { border-top: none; }
    .txf-panel .txf-row > div { flex: 1; min-width: 0; }
    .txf-panel .txf-row small { display: block; color: var(--muted); font-size: 13px; }
    .txf-panel input[type=checkbox] { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--accent); }
    .txf-panel input[type=range] { width: 100%; accent-color: var(--accent); }
    .txf-panel input[type=password], .txf-panel select {
      width: 100%; box-sizing: border-box; background: transparent; color: var(--fg);
      border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: inherit;
    }
    .txf-panel select option { background: var(--bg); }
    .txf-panel .txf-thr { display: flex; justify-content: space-between; color: var(--muted); font-size: 13px; margin-top: 6px; }
    .txf-panel .txf-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }
    .txf-panel .txf-actions button {
      border-radius: 999px; padding: 8px 16px; font: 600 14px -apple-system, "Segoe UI", sans-serif; cursor: pointer;
      background: transparent; color: var(--fg); border: 1px solid var(--line);
    }
    .txf-panel .txf-actions .txf-primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
    .txf-panel .txf-actions .txf-left { margin-right: auto; }
    .txf-panel a { color: var(--accent); }
  `);

  // ---------- Jev request ----------
  function requestJev(posts) {
    const state = { examples_of_bait: BAIT_EXAMPLES };
    const questions = {};
    posts.forEach((p, i) => {
      state[`post_${i}`] = p;
      for (const k of AI_KEYS) questions[`p${i}_${k}`] = FILTERS[k].question(`post_${i}`);
    });
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: API_URL,
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': APP,
        },
        data: JSON.stringify({ model: MODEL, state, questions }),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const { answers, usage } = JSON.parse(res.responseText);
              const scores = posts.map((_, i) => {
                const s = {};
                for (const k of AI_KEYS) {
                  const a = answers[`p${i}_${k}`];
                  if (!a || typeof a.noul !== 'number') return null;
                  s[k] = a.noul;
                }
                return s;
              });
              resolve({ scores, cost: usage?.cost || 0 });
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
  const pending = new Map();   // hash -> { post, articles:Set, sent }
  let inFlight = 0;
  let flushTimer = null;
  let authFailed = false;

  function enqueue(h, post, article) {
    let entry = pending.get(h);
    if (!entry) pending.set(h, (entry = { post, articles: new Set(), sent: false }));
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
      const { scores, cost } = await requestJev(batch.map(([, e]) => e.post));
      stats = { posts: stats.posts + batch.length, cost: stats.cost + cost };
      batch.forEach(([h, e], i) => {
        pending.delete(h);
        if (!scores[i]) return;
        cache[h] = [scores[i], Date.now()];
        for (const a of e.articles) if (a.isConnected && a.dataset.txfHash === h) applyVerdict(a, scores[i]);
      });
      saveCacheSoon();
    } catch (err) {
      console.warn(`[${APP}]`, err.message);
      if (err.status === 401 || err.status === 403) {
        authFailed = true;
        toast(`${APP}: OpenRouter rejected the API key. Set a new one in Settings (Tampermonkey menu).`);
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

  // ---------- reading posts ----------
  function getText(article) {
    const n = article.querySelector('[data-testid="tweetText"]');
    return n ? n.innerText.trim().slice(0, MAX_CHARS) : '';
  }

  function getAuthor(article) {
    const header = article.querySelector('[data-testid="User-Name"]');
    if (!header) return { name: '', handle: '', account: 'unverified' };
    const handle = [...header.querySelectorAll('span')]
      .map((s) => s.textContent.trim())
      .find((t) => /^@\w+$/.test(t)) || '';
    const nameLink = header.querySelector('a');
    const name = (nameLink ? nameLink.textContent : '').replace(handle, '').trim();
    const badge = header.querySelector('[data-testid="icon-verified"]');
    // gold (organization) checks are drawn with a gradient, blue ones with a flat fill
    const account = !badge ? 'unverified' : badge.querySelector('linearGradient') ? 'verified organization' : 'verified';
    return { name, handle, account };
  }

  // X labels paid posts with a bare "Ad" (older UI: "Promoted") outside the post text
  function isPaidAd(article) {
    for (const s of article.querySelectorAll('span')) {
      if (s.childElementCount) continue;
      const t = s.textContent.trim();
      if ((t === 'Ad' || t === 'Promoted') && !s.closest('[data-testid="tweetText"], [data-testid="User-Name"]')) return true;
    }
    return false;
  }

  // ---------- applying verdicts ----------
  function hitsFor(scores) {
    return Object.keys(FILTERS)
      .filter((k) => settings.filters[k].on && scores[k] != null)
      .filter((k) => !FILTERS[k].ai || scores[k] >= settings.filters[k].threshold)
      .sort((a, b) => scores[b] - scores[a]);
  }

  const hitText = (k, scores) => FILTERS[k].ai ? `${FILTERS[k].label} (${Math.round(scores[k] * 100)}%)` : FILTERS[k].label;

  function applyVerdict(article, scores) {
    const hits = hitsFor(scores);

    if (settings.showScores) {
      let badge = article.querySelector(':scope > .txf-score');
      if (!badge) {
        badge = el('div', 'txf-score');
        if (getComputedStyle(article).position === 'static') article.style.position = 'relative';
        article.prepend(badge);
      }
      badge.textContent = scores.ad ? 'ad' : AI_KEYS.map((k) => `${k} ${scores[k].toFixed(2)}`).join(' · ');
      badge.classList.toggle('txf-hot', hits.length > 0);
    }
    if (!hits.length) return;

    const cell = article.closest('[data-testid="cellInnerDiv"]') || article.parentElement;
    if (settings.mode === 'hide') {
      cell.style.display = 'none';
      cell.dataset.txfHidden = '1';
      return;
    }
    if (article.previousElementSibling?.classList.contains('txf-bar')) return;

    const what = hits.map((k) => hitText(k, scores)).join(' + ');
    const bar = el('div', 'txf-bar');
    const label = el('span', 'txf-label');
    const btn = el('button');
    btn.type = 'button';
    bar.append(label, authorInfo(article), btn);

    const setOpen = (open) => {
      article.style.display = open ? '' : 'none';
      article.classList.toggle('txf-revealed', open);
      bar.classList.toggle('txf-open', open);
      label.textContent = open ? what : `${what} hidden`;
      btn.textContent = open ? 'Hide' : 'Show';
      if (open) article.dataset.txfRevealed = '1';
      else delete article.dataset.txfRevealed;
    };
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(!article.dataset.txfRevealed);
    });
    article.before(bar);
    setOpen(!!article.dataset.txfRevealed);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // "· Display Name ✓ @handle"
  function authorInfo(article) {
    const wrap = el('span', 'txf-who');
    const { name, handle, account } = getAuthor(article);
    if (!name && !handle) return wrap;
    wrap.append(el('span', 'txf-sep', '·'));
    if (name) wrap.append(el('span', 'txf-name', name));
    if (account !== 'unverified') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 22 22');
      svg.setAttribute('class', account === 'verified organization' ? 'txf-check txf-org' : 'txf-check');
      svg.setAttribute('aria-label', 'Verified');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M20.4 11c0-1.4-.9-2.7-2.1-3.3.5-1.3.2-2.8-.8-3.8s-2.5-1.3-3.8-.8C13.1 1.9 11.9 1 10.5 1S7.9 1.9 7.3 3.1c-1.3-.5-2.8-.2-3.8.8s-1.3 2.5-.8 3.8C1.5 8.3.6 9.6.6 11s.9 2.7 2.1 3.3c-.5 1.3-.2 2.8.8 3.8s2.5 1.3 3.8.8c.6 1.2 1.8 2.1 3.2 2.1s2.6-.9 3.2-2.1c1.3.5 2.8.2 3.8-.8s1.3-2.5.8-3.8c1.3-.6 2.1-1.9 2.1-3.3zm-11 4.6L5.8 12l1.3-1.3 2.3 2.3 5.4-5.6 1.4 1.3-6.8 6.9z');
      svg.append(path);
      wrap.append(svg);
    }
    if (handle) wrap.append(el('span', 'txf-handle', handle));
    return wrap;
  }

  function resetArticle(article) {
    article.style.display = '';
    article.classList.remove('txf-revealed');
    delete article.dataset.txfRevealed;
    if (article.previousElementSibling?.classList.contains('txf-bar')) article.previousElementSibling.remove();
    article.querySelector(':scope > .txf-score')?.remove();
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    if (cell?.dataset.txfHidden) { cell.style.display = ''; delete cell.dataset.txfHidden; }
  }

  function processArticle(article) {
    if (!settings.enabled) return;
    const ad = isPaidAd(article);
    const text = getText(article);
    const author = getAuthor(article);
    const id = hash(`${author.name}\n${author.account}\n${text}`);
    const key = ad ? `ad:${id}` : text.length >= MIN_CHARS ? id : '';
    // X recycles DOM nodes while scrolling, so re-check when the content changes
    if (article.dataset.txfHash === key) return;
    if (article.dataset.txfHash !== undefined) resetArticle(article);
    article.dataset.txfHash = key;
    if (!key) return;
    if (ad) return applyVerdict(article, { ad: 1 });
    const hit = cache[key];
    if (hit) applyVerdict(article, hit[0]);
    else enqueue(key, { author: author.name, account: author.account, text }, article);
  }

  function syncTheme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    const light = m ? (+m[0] + +m[1] + +m[2]) / 3 > 128 : false;
    document.documentElement.classList.toggle('txf-light', light);
  }

  function scan() {
    syncTheme();
    document.querySelectorAll('article[data-testid="tweet"]').forEach(processArticle);
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
      delete a.dataset.txfHash;
    });
    scan();
  }

  // ---------- UI ----------
  function toast(msg) {
    const t = el('div', '', msg);
    Object.assign(t.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgb(29,155,240)', color: '#fff', padding: '10px 16px', borderRadius: '8px',
      zIndex: 99999, font: '14px -apple-system, "Segoe UI", sans-serif', maxWidth: '90vw',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  function openSettings() {
    if (document.querySelector('.txf-overlay')) return;
    syncTheme();
    const draft = JSON.parse(JSON.stringify(settings.filters));
    const overlay = el('div', 'txf-overlay');
    const panel = el('div', 'txf-panel');
    overlay.append(panel);

    panel.append(el('h2', '', APP));
    panel.append(el('p', 'txf-sub',
      `${stats.posts.toLocaleString()} posts checked so far · $${stats.cost.toFixed(4)} spent on Jev`));

    panel.append(el('h3', '', 'Filters'));
    for (const [k, f] of Object.entries(FILTERS)) {
      const row = el('label', 'txf-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = draft[k].on;
      cb.addEventListener('change', () => { draft[k].on = cb.checked; });
      const body = el('div');
      body.append(el('strong', '', f.label), el('small', '', f.desc));
      if (f.ai) {
        const range = el('input');
        Object.assign(range, { type: 'range', min: '0.3', max: '0.95', step: '0.05', value: String(draft[k].threshold) });
        const thr = el('div', 'txf-thr');
        const val = el('span', '', `Hide at ${Math.round(draft[k].threshold * 100)}%+`);
        thr.append(el('span', '', 'stricter ←'), val, el('span', '', '→ looser'));
        range.addEventListener('input', () => {
          draft[k].threshold = parseFloat(range.value);
          val.textContent = `Hide at ${Math.round(draft[k].threshold * 100)}%+`;
        });
        body.append(range, thr);
      }
      row.append(cb, body);
      panel.append(row);
    }

    panel.append(el('h3', '', 'Display'));
    const modeRow = el('div', 'txf-row');
    const modeBody = el('div');
    const mode = el('select');
    mode.append(new Option('Collapse to a bar with Show / Hide', 'collapse'), new Option('Remove completely', 'hide'));
    mode.value = settings.mode;
    modeBody.append(mode);
    modeRow.append(modeBody);
    const scoreRow = el('label', 'txf-row');
    const scoreCb = el('input');
    scoreCb.type = 'checkbox';
    scoreCb.checked = settings.showScores;
    const scoreBody = el('div');
    scoreBody.append(el('strong', '', 'Score badges'), el('small', '', 'Show every post’s scores, handy for picking thresholds.'));
    scoreRow.append(scoreCb, scoreBody);
    panel.append(modeRow, scoreRow);

    panel.append(el('h3', '', 'OpenRouter API key'));
    const key = el('input');
    Object.assign(key, { type: 'password', value: settings.apiKey, placeholder: 'sk-or-…', autocomplete: 'off' });
    const keyHelp = el('small', 'txf-sub');
    keyHelp.append('Stored in Tampermonkey, only sent to openrouter.ai. Get one at ');
    const a = el('a', '', 'openrouter.ai/settings/keys');
    Object.assign(a, { href: 'https://openrouter.ai/settings/keys', target: '_blank', rel: 'noopener' });
    keyHelp.append(a, '.');
    panel.append(key, keyHelp);

    const actions = el('div', 'txf-actions');
    const clear = el('button', 'txf-left', 'Clear cache');
    const cancel = el('button', '', 'Cancel');
    const save = el('button', 'txf-primary', 'Save');
    actions.append(clear, cancel, save);
    panel.append(actions);

    const close = () => overlay.remove();
    clear.addEventListener('click', () => {
      cache = {};
      GM_setValue(CACHE_KEY, cache);
      clear.textContent = 'Cache cleared';
      clear.disabled = true;
    });
    cancel.addEventListener('click', close);
    save.addEventListener('click', () => {
      const newKey = key.value.trim();
      if (newKey !== settings.apiKey) {
        settings.apiKey = newKey;
        authFailed = false;
        pending.forEach((e) => { e.sent = false; });
      }
      settings.filters = draft;
      settings.mode = mode.value;
      settings.showScores = scoreCb.checked;
      GM_setValue('apiKey', settings.apiKey);
      GM_setValue('filters', settings.filters);
      GM_setValue('mode', settings.mode);
      GM_setValue('showScores', settings.showScores);
      close();
      rescanAll();
      flush();
    });
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    // keep X's keyboard shortcuts (j, k, l, n...) from firing while typing in the panel
    overlay.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') close();
    });
    document.body.append(overlay);
    if (!settings.apiKey) key.focus();
  }

  GM_registerMenuCommand('Settings', openSettings);
  GM_registerMenuCommand('Pause / resume', () => {
    settings.enabled = !settings.enabled;
    GM_setValue('enabled', settings.enabled);
    toast(`${APP}: ${settings.enabled ? 'on' : 'paused'}`);
    rescanAll();
  });

  // ---------- start ----------
  if (!settings.apiKey) setTimeout(openSettings, 800);
  scan();
})();
