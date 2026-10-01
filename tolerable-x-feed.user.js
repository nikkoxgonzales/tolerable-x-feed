// ==UserScript==
// @name         Tolerable X Feed
// @namespace    https://github.com/nikkoxgonzales
// @version      2.3.0
// @description  Makes your X/Twitter feed tolerable: hides engagement bait, promo posts and paid ads, using TypeSafe's Jev decision model (OpenRouter, TypeSafe, or self-hosted).
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
// @connect      api.typesafe.ai
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- config ----------
  const APP = 'Tolerable X Feed';
  // All three speak the same System One request shape: { model, state, questions } -> { answers, usage }
  const PROVIDERS = {
    openrouter: {
      label: 'OpenRouter',
      url: 'https://openrouter.ai/api/alpha/decisions',
      model: '~typesafe/jev-latest',
      keyHint: 'sk-or-…',
      keyLink: 'https://openrouter.ai/settings/keys',
    },
    typesafe: {
      label: 'TypeSafe',
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      keyHint: 'TypeSafe API key',
      keyLink: 'https://typesafe.ai',
    },
    custom: {
      label: 'Custom / self-hosted',
      url: '',
      model: 'jev-1.13',
      keyHint: 'Bearer token (optional)',
    },
  };
  const BATCH_SIZE = 16;         // posts per request; tested up to 16 with no accuracy loss
  const FLUSH_DELAY_MS = 350;    // wait this long to fill a batch while scrolling
  const MAX_IN_FLIGHT = 2;
  const MAX_CHARS = 1000;
  const MIN_CHARS = 8;
  const CACHE_KEY = 'cache_v4';  // bump when the question set or text extraction changes
  const SAVE_DELAY_MS = 5000;
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

  // Each AI filter is one Jev "noul" (yes/no probability) question per post. The definition is sent
  // once per request in state.definitions and every question just points at it: 3x fewer tokens than
  // repeating it in each question, with the same accuracy (see README "Efficiency").
  // All filters are asked for every post so cached scores stay complete when you toggle filters.
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
      term: 'engagement_bait',
      definition: {
        means: 'A generic, open-ended prompt aimed at the whole audience (hypothetical, "name one", "would you rather", "be honest", hot-take poll, "what\'s the most overrated...") written mainly to farm replies, opinions, or debate, without sharing real information or asking for specific help.',
        is_not: 'News, work, an announcement, a personal update, a joke, or a specific, genuine question someone needs answered.',
        examples: BAIT_EXAMPLES,
      },
    },
    promo: {
      label: 'Promo',
      desc: 'Product launches, pricing, discount codes, webinars, "try it now" links.',
      ai: true,
      term: 'promotional_marketing',
      definition: {
        means: 'The author advertises something they or their company offer: a product, service, launch, feature release, pricing, sale, discount code, course, webinar or event signup, "try it now" link, or a request for upvotes or purchases. A verified organization account is a company or brand.',
        is_not: "News reporting, a personal update, an opinion, a joke, a technical discussion, research, or a question that is not trying to get the reader to buy, sign up for, or try the author's offering.",
      },
    },
  };
  const AI_KEYS = Object.keys(FILTERS).filter((k) => FILTERS[k].ai);
  const DEFINITIONS = Object.fromEntries(AI_KEYS.map((k) => [FILTERS[k].term, FILTERS[k].definition]));

  // ---------- settings ----------
  const DEFAULT_FILTERS = { ad: { on: true }, bait: { on: true, threshold: 0.6 }, promo: { on: true, threshold: 0.6 } };
  const savedFilters = GM_getValue('filters', {});
  // per provider: { url, model, key, headers } — blank url/model fall back to the preset
  const savedProviders = GM_getValue('providers', {});
  const settings = {
    provider: GM_getValue('provider', 'openrouter'),
    providers: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, { url: '', model: '', key: '', headers: '', ...savedProviders[p] }])),
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
  // carry over the single OpenRouter key from 2.0
  if (GM_getValue('apiKey', null) != null) {
    settings.providers.openrouter.key = GM_getValue('apiKey');
    GM_setValue('providers', settings.providers);
    GM_deleteValue('apiKey');
  }
  let stats = GM_getValue('stats', { posts: 0, cost: 0 });

  function endpoint(name = settings.provider, cfg = settings.providers[name]) {
    const preset = PROVIDERS[name];
    let headers = {};
    try { headers = cfg.headers ? JSON.parse(cfg.headers) : {}; } catch { /* validated in settings */ }
    return {
      name,
      label: preset.label,
      url: (cfg.url || preset.url).trim(),
      model: (cfg.model || preset.model).trim(),
      key: cfg.key.trim(),
      headers,
    };
  }

  // custom endpoints may run without auth; hosted ones need a key
  const isReady = (ep = endpoint()) => !!ep.url && (ep.name === 'custom' || !!ep.key);

  // ---------- cache (author+text hash -> [{bait, promo}, timestamp]) ----------
  for (const old of ['cache_v2', 'cache_v3']) GM_deleteValue(old);
  let cache = GM_getValue(CACHE_KEY, {});
  // new results since the last save; merged into storage so several open tabs don't overwrite each other
  let fresh = {};
  let statsDelta = { posts: 0, cost: 0 };
  let saveTimer = null;
  function saveCacheSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const stored = Object.assign(GM_getValue(CACHE_KEY, {}), fresh);
      const keys = Object.keys(stored);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => stored[a][1] - stored[b][1]);
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete stored[k];
      }
      GM_setValue(CACHE_KEY, stored);
      cache = stored;
      fresh = {};
      const st = GM_getValue('stats', { posts: 0, cost: 0 });
      stats = { posts: st.posts + statsDelta.posts, cost: st.cost + statsDelta.cost };
      GM_setValue('stats', stats);
      statsDelta = { posts: 0, cost: 0 };
    }, SAVE_DELAY_MS);
  }

  const hasAllScores = (sc) => !!sc && AI_KEYS.every((k) => typeof sc[k] === 'number');
  const anyAiFilterOn = () => AI_KEYS.some((k) => settings.filters[k].on);

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
      color: rgb(113,118,123); cursor: default;
    }
    article.txf-collapsed > :not(.txf-bar):not(.txf-score) { display: none !important; }
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
    .txf-bar.txf-open { color: rgb(255,173,31); }
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
    .txf-panel .txf-field { margin-top: 10px; }
    .txf-panel .txf-field label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
    .txf-panel > small.txf-sub { display: block; margin-top: 6px; }
    .txf-panel .txf-test { display: flex; gap: 10px; align-items: center; margin-top: 12px; font-size: 13px; color: var(--muted); }
    .txf-panel .txf-test button {
      flex: none; border-radius: 999px; padding: 6px 14px; font: 600 13px -apple-system, "Segoe UI", sans-serif;
      cursor: pointer; background: transparent; color: var(--accent); border: 1px solid var(--accent);
    }
    .txf-panel .txf-test button:disabled { opacity: .5; cursor: default; }
    .txf-panel .txf-test span { min-width: 0; overflow-wrap: anywhere; }
    .txf-panel input[type=text], .txf-panel input[type=password], .txf-panel select {
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

  // ---------- System One request ----------
  function callSystemOne(ep, body) {
    const headers = { 'Content-Type': 'application/json', ...ep.headers };
    if (ep.key) headers.Authorization = `Bearer ${ep.key}`;
    if (ep.name === 'openrouter') headers['X-Title'] = APP;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: ep.url,
        timeout: 30000,
        headers,
        data: JSON.stringify({ model: ep.model, ...body }),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(Object.assign(new Error('Response is not JSON: ' + res.responseText.slice(0, 200)), { retry: false }));
            }
          } else {
            const retry = res.status === 429 || res.status >= 500 || res.status === 402;
            const after = /^retry-after:\s*(\d+)/im.exec(res.responseHeaders || '');
            reject(Object.assign(new Error(`${ep.label} ${res.status}: ${(res.responseText || '').slice(0, 300)}`),
              { retry, status: res.status, retryAfterMs: after ? +after[1] * 1000 : 0 }));
          }
        },
        onerror: () => reject(Object.assign(new Error(`Could not reach ${ep.url}`), { retry: true })),
        ontimeout: () => reject(Object.assign(new Error(`Timed out calling ${ep.url}`), { retry: true })),
      });
    });
  }

  async function requestJev(posts, ep = endpoint()) {
    const state = { definitions: DEFINITIONS };
    const questions = {};
    posts.forEach((p, i) => {
      state[`post_${i}`] = p;
      for (const k of AI_KEYS) {
        questions[`p${i}_${k}`] = { type: 'noul', instructions: `Is \`post_${i}\` \`definitions.${FILTERS[k].term}\`?` };
      }
    });
    const res = await callSystemOne(ep, { state, questions });
    if (!res || typeof res.answers !== 'object') {
      throw Object.assign(new Error('Response has no "answers" — is this a System One endpoint?'), { retry: false });
    }
    const scores = posts.map((_, i) => {
      const s = {};
      for (const k of AI_KEYS) {
        const a = res.answers[`p${i}_${k}`];
        if (!a || typeof a.noul !== 'number') return null;
        s[k] = Math.round(a.noul * 1000) / 1000;
      }
      return s;
    });
    return { scores, cost: res.usage?.cost || 0, model: res.model || ep.model };
  }

  // ---------- queue ----------
  const pending = new Map();   // hash -> { post, articles:Set, sent }
  let inFlight = 0;
  let flushTimer = null;
  let authFailed = false;
  let lastErrorToast = 0;

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
    if (authFailed || !isReady()) return;
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
      statsDelta.posts += batch.length;
      statsDelta.cost += cost;
      batch.forEach(([h, e], i) => {
        pending.delete(h);
        if (!scores[i]) return;
        cache[h] = fresh[h] = [scores[i], Date.now()];
        for (const a of e.articles) if (a.isConnected && a.dataset.txfId === h) applyVerdict(a, scores[i]);
      });
      saveCacheSoon();
    } catch (err) {
      console.warn(`[${APP}]`, err.message);
      if (err.status === 401 || err.status === 403) {
        if (!authFailed) toast(`${APP}: ${endpoint().label} rejected the API key. Fix it in Settings (Tampermonkey menu).`);
        authFailed = true;
        batch.forEach(([, e]) => { e.sent = false; });   // re-sent once the key is fixed
      } else if (err.retry && attempt < 3) {
        inFlight--;
        setTimeout(() => sendBatch(batch, attempt + 1), err.retryAfterMs || 2000 * 2 ** attempt);
        return;
      } else {
        batch.forEach(([h]) => pending.delete(h));
        if (Date.now() - lastErrorToast > 60000) {
          lastErrorToast = Date.now();
          toast(`${APP}: ${err.message}`);
        }
      }
    }
    inFlight--;
    if (pending.size) scheduleFlush();
  }

  // ---------- reading posts ----------
  // walks the DOM instead of using innerText, which forces a layout on every call;
  // X draws emoji as <img alt="🚀">, so those are kept too
  function getText(article) {
    const root = article.querySelector('[data-testid="tweetText"]');
    if (!root) return '';
    let out = '';
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeName === 'IMG') out += c.alt || '';
        else if (c.nodeName === 'BR') out += '\n';
        else if (c.nodeType === 1) walk(c);
      }
    })(root);
    return out.trim().slice(0, MAX_CHARS);
  }

  let ownHandle = null;
  function getOwnHandle() {
    if (!ownHandle) {
      const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
      if (href) ownHandle = '@' + href.replace(/^\//, '').toLowerCase();
    }
    return ownHandle;
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
      badge.textContent = scores.ad ? 'ad' : AI_KEYS.map((k) => `${k} ${(scores[k] ?? 0).toFixed(2)}`).join(' · ');
      badge.classList.toggle('txf-hot', hits.length > 0);
    }
    if (!hits.length) return;

    const cell = article.closest('[data-testid="cellInnerDiv"]') || article.parentElement;
    if (settings.mode === 'hide') {
      cell.style.display = 'none';
      cell.dataset.txfHidden = '1';
      return;
    }
    if (article.querySelector(':scope > .txf-bar')) return;

    // The bar lives inside the article, so it goes away with it when X re-renders or recycles the node
    const what = hits.map((k) => hitText(k, scores)).join(' + ');
    const bar = el('div', 'txf-bar');
    const label = el('span', 'txf-label');
    const btn = el('button');
    btn.type = 'button';
    bar.append(label, authorInfo(article), btn);

    const setOpen = (open) => {
      article.classList.toggle('txf-collapsed', !open);
      article.classList.toggle('txf-revealed', open);
      bar.classList.toggle('txf-open', open);
      label.textContent = open ? what : `${what} hidden`;
      btn.textContent = open ? 'Hide' : 'Show';
    };
    // keep clicks on the bar from opening the post
    bar.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ev.target === btn) {
        ev.preventDefault();
        setOpen(article.classList.contains('txf-collapsed'));
      }
    });
    article.prepend(bar);
    setOpen(false);
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
    article.classList.remove('txf-collapsed', 'txf-revealed');
    article.querySelector(':scope > .txf-bar')?.remove();
    article.querySelector(':scope > .txf-score')?.remove();
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    if (cell?.dataset.txfHidden) { cell.style.display = ''; delete cell.dataset.txfHidden; }
  }

  function processArticle(article) {
    if (!settings.enabled) return;
    const text = getText(article);
    const author = getAuthor(article);
    const ad = isPaidAd(article);
    const id = hash(`${author.name}\n${author.account}\n${text}`) + (ad ? ':ad' : '');
    // X recycles DOM nodes while scrolling, so only re-check when the content changes
    if (article.dataset.txfId === id) return;
    if (article.dataset.txfId !== undefined) resetArticle(article);
    article.dataset.txfId = id;

    if (author.handle && author.handle.toLowerCase() === getOwnHandle()) return;   // never your own posts
    if (ad) return applyVerdict(article, { ad: 1 });
    if (text.length < MIN_CHARS || !anyAiFilterOn()) return;
    const hit = cache[id];
    if (hit && hasAllScores(hit[0])) applyVerdict(article, hit[0]);
    else enqueue(id, { author: author.name, account: author.account, text }, article);
  }

  let themeCheckedAt = 0;
  function syncTheme(force) {
    const now = Date.now();
    if (!force && now - themeCheckedAt < 1000) return;
    themeCheckedAt = now;
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
      delete a.dataset.txfId;
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
    syncTheme(true);
    const draft = JSON.parse(JSON.stringify(settings.filters));
    const overlay = el('div', 'txf-overlay');
    const panel = el('div', 'txf-panel');
    overlay.append(panel);

    panel.append(el('h2', '', APP));
    const checked = stats.posts + statsDelta.posts, spent = stats.cost + statsDelta.cost;
    panel.append(el('p', 'txf-sub', `${checked.toLocaleString()} posts checked so far` +
      (spent > 0 ? ` · $${spent.toFixed(4)} spent` : '')));

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

    // ---- AI provider ----
    panel.append(el('h3', '', 'AI provider'));
    const draftProviders = JSON.parse(JSON.stringify(settings.providers));
    let current = settings.provider;
    const provider = el('select');
    for (const [p, def] of Object.entries(PROVIDERS)) provider.append(new Option(def.label, p));
    provider.value = current;

    const field = (labelText, input) => {
      const wrap = el('div', 'txf-field');
      wrap.append(el('label', '', labelText), input);
      panel.append(wrap);
      return wrap;
    };
    const input = (type) => Object.assign(el('input'), { type, autocomplete: 'off', spellcheck: false });
    const url = input('text');
    const model = input('text');
    const key = input('password');
    const headers = input('text');
    field('Provider', provider);
    field('Endpoint URL', url);
    field('Model', model);
    field('API key', key);
    const headersField = field('Extra headers (JSON, optional)', headers);
    headers.placeholder = '{"X-Api-Key": "…"}';
    const keyHelp = el('small', 'txf-sub');
    panel.append(keyHelp);

    const loadProvider = (p) => {
      const def = PROVIDERS[p], cfg = draftProviders[p];
      url.value = cfg.url;
      url.placeholder = def.url || 'http://192.168.1.10:8224/v1/systemone';
      model.value = cfg.model;
      model.placeholder = def.model;
      key.value = cfg.key;
      key.placeholder = def.keyHint;
      headers.value = cfg.headers;
      headersField.style.display = p === 'custom' ? '' : 'none';
      keyHelp.textContent = '';
      if (def.keyLink) {
        keyHelp.append('Blank URL/model use the defaults. Get a key at ');
        const a = Object.assign(el('a', '', def.keyLink.replace(/^https:\/\//, '')), { href: def.keyLink, target: '_blank', rel: 'noopener' });
        keyHelp.append(a, '.');
      } else {
        keyHelp.append('Any server that speaks the System One API (POST { model, state, questions }). Tampermonkey will ask once to allow the host.');
      }
    };
    const storeProvider = (p) => {
      Object.assign(draftProviders[p], { url: url.value.trim(), model: model.value.trim(), key: key.value.trim(), headers: headers.value.trim() });
    };
    provider.addEventListener('change', () => {
      storeProvider(current);
      current = provider.value;
      loadProvider(current);
      testResult.textContent = '';
    });
    loadProvider(current);

    const headersValid = () => {
      if (!headers.value.trim()) return true;
      try {
        const h = JSON.parse(headers.value);
        return h && typeof h === 'object' && !Array.isArray(h);
      } catch { return false; }
    };

    const testRow = el('div', 'txf-test');
    const testBtn = el('button', '', 'Test connection');
    testBtn.type = 'button';
    const testResult = el('span');
    testRow.append(testBtn, testResult);
    panel.append(testRow);
    testBtn.addEventListener('click', async () => {
      storeProvider(current);
      if (!headersValid()) { testResult.textContent = '✗ Extra headers must be a JSON object.'; return; }
      const ep = endpoint(current, draftProviders[current]);
      if (!isReady(ep)) { testResult.textContent = ep.url ? '✗ Enter an API key first.' : '✗ Enter an endpoint URL first.'; return; }
      testBtn.disabled = true;
      testResult.textContent = 'Testing…';
      const t0 = performance.now();
      try {
        const { scores, model: served } = await requestJev([
          { author: 'Test', account: 'verified', text: 'Name one tool you could never code without.' },
          { author: 'Test', account: 'unverified', text: 'Had the best ramen of my life in Osaka today.' },
        ], ep);
        if (!scores[0] || !scores[1]) throw new Error('Answers are missing noul values.');
        testResult.textContent = `✓ ${served} · ${Math.round(performance.now() - t0)} ms · ` +
          `bait sample ${scores[0].bait.toFixed(2)}, normal sample ${scores[1].bait.toFixed(2)}`;
      } catch (err) {
        testResult.textContent = `✗ ${err.message}`;
      }
      testBtn.disabled = false;
    });

    const actions = el('div', 'txf-actions');
    const clear = el('button', 'txf-left', 'Clear cache');
    const cancel = el('button', '', 'Cancel');
    const save = el('button', 'txf-primary', 'Save');
    actions.append(clear, cancel, save);
    panel.append(actions);

    const close = () => overlay.remove();
    clear.addEventListener('click', () => {
      cache = {};
      fresh = {};
      GM_setValue(CACHE_KEY, cache);
      clear.textContent = 'Cache cleared';
      clear.disabled = true;
    });
    cancel.addEventListener('click', close);
    save.addEventListener('click', () => {
      storeProvider(current);
      if (!headersValid()) {
        testResult.textContent = '✗ Extra headers must be a JSON object.';
        headers.focus();
        return;
      }
      settings.provider = current;
      settings.providers = draftProviders;
      authFailed = false;
      settings.filters = draft;
      settings.mode = mode.value;
      settings.showScores = scoreCb.checked;
      GM_setValue('provider', settings.provider);
      GM_setValue('providers', settings.providers);
      GM_setValue('filters', settings.filters);
      GM_setValue('mode', settings.mode);
      GM_setValue('showScores', settings.showScores);
      close();
      rescanAll();
      flush();
    });
    // close on a backdrop click, but not when a text-selection drag ends outside the panel
    let downOnBackdrop = false;
    overlay.addEventListener('mousedown', (ev) => { downOnBackdrop = ev.target === overlay; });
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay && downOnBackdrop) close(); });
    // keep X's keyboard shortcuts (j, k, l, n...) from firing while typing in the panel
    overlay.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') close();
    });
    document.body.append(overlay);
    if (!isReady()) (url.value || PROVIDERS[current].url ? key : url).focus();
  }

  GM_registerMenuCommand('Settings', openSettings);
  GM_registerMenuCommand('Pause / resume', () => {
    settings.enabled = !settings.enabled;
    GM_setValue('enabled', settings.enabled);
    toast(`${APP}: ${settings.enabled ? 'on' : 'paused'}`);
    rescanAll();
  });

  // ---------- start ----------
  if (!isReady()) setTimeout(openSettings, 800);
  scan();
})();
