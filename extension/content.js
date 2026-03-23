console.log('[CONTENT] Script loaded');

if (!window.__contextExtensionLoaded) {
  window.__contextExtensionLoaded = true;

  const DEDUP_WINDOW = 600000;
  const seenTerms = new Map();
  let lastSessionStart = null;
  let hasCards = false;

  let ignoreList = new Set();
  let settings = {
    cardsPerChunk: 3,
    sidebarPosition: 'right',
    autoHide: false
  };
  let autoHideTimer = null;
  let shadowRoot = null;
  let hostEl = null;
  let listeningTimer = null;
  let badgeEl = null;
  let badgeShadow = null;
  let termCount = 0;
  let askIdleTimer = null;
  let askSuggestionCount = 0;
  let lastRenderedTerm = '';
  const isYouTubeSite = window.location.hostname.includes('youtube.com');

  const TYPE_COLORS = {
    event: '#ff9500',
    concept: '#7070ff',
    person: '#00d4aa',
    people: '#00d4aa',
    stock: '#00e676',
    organization: '#4d9fff',
    commodity: '#ff9500'
  };

  function getTypeColor(type) {
    return TYPE_COLORS[(type || '').toLowerCase()] || '#4a4a6a';
  }

  chrome.storage.local.get(['ignoreList', 'extensionSettings'], (data) => {
    if (data.ignoreList) ignoreList = new Set(data.ignoreList);
    if (data.extensionSettings) settings = { ...settings, ...data.extensionSettings };
  });

  // Check if this tab is the one being captured
  function isActiveTab(callback) {
    chrome.storage.local.get(['activeTabUrl'], (data) => {
      if (chrome.runtime.lastError) { callback(false); return; }
      const activeUrl = data.activeTabUrl || '';
      try {
        const active = new URL(activeUrl);
        const current = new URL(window.location.href);
        callback(active.origin + active.pathname === current.origin + current.pathname);
      } catch (e) {
        callback(activeUrl === window.location.href);
      }
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.extensionSettings) {
      settings = { ...settings, ...changes.extensionSettings.newValue };
      applySidebarPosition();
    }
  });

  function detectSiteTheme() {
    let bg = 'rgb(0, 0, 0)';
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break; }
    }
    const match = bg.match(/\d+/g);
    if (!match) return false;
    const [r, g, b] = match.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b);
    return luminance > 128;
  }

  function applyTheme() {
    const light = detectSiteTheme();
    if (light === isLightTheme) return;
    isLightTheme = light;
    console.log('[CONTENT] Theme detected:', light ? 'light' : 'dark');

    // Update sidebar
    if (shadowRoot) {
      const sidebar = shadowRoot.getElementById('sidebar');
      if (sidebar) sidebar.classList.toggle('light-theme', light);
    }
    // Update host element background
    if (hostEl) {
      applySidebarPosition();
    }
    // Update badge
    if (badgeShadow) {
      const badge = badgeShadow.querySelector('.ctx-badge');
      if (badge) badge.classList.toggle('light', light);
    }
  }

  // Detect theme on load (defer to allow styles to apply)
  setTimeout(applyTheme, 500);

  // Re-check on SPA navigation
  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      setTimeout(applyTheme, 500);
    }
  });
  urlObserver.observe(document.documentElement, { childList: true, subtree: true });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(date) {
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const mins = minutes < 10 ? '0' + minutes : minutes;
    return `${hours}:${mins} ${ampm}`;
  }

  function firstSentence(str) {
    if (!str) return '';
    const idx = str.indexOf('.');
    return idx === -1 ? str : str.slice(0, idx + 1);
  }

  const SHADOW_CSS = `
    :host {
      display: block;
      background: #12121c;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    #sidebar {
      position: relative; width: 100%; height: 100%; background: #12121c;
      display: flex; flex-direction: column; overflow: hidden; margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0f0;
    }
    #header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 12px 12px 16px; background: #12121c;
      border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
      overflow: hidden;
    }
    .ctx-wordmark { font-size: 13px; font-weight: 600; color: #e0e0f0; letter-spacing: -0.01em; }
    .ctx-header-right { display: flex; align-items: center; gap: 10px; }
    .ctx-live { display: flex; align-items: center; gap: 5px; }
    .ctx-live-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #00e676;
      animation: ctx-pulse 2s ease-in-out infinite;
    }
    .ctx-live-text { font-size: 10px; color: #00e676; font-weight: 500; }
    .ctx-close-btn, .ctx-export-btn {
      background: none; border: none; color: #3a3a5a; font-size: 16px;
      cursor: pointer; padding: 2px 6px; border-radius: 4px;
      line-height: 1; transition: color 0.15s, background 0.15s;
      position: relative;
    }
    .ctx-close-btn:hover, .ctx-export-btn:hover { color: #8a8aaa; background: rgba(255,255,255,0.05); }
    .ctx-export-btn { font-size: 13px; }
    .ctx-export-tooltip {
      position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
      background: #00e676; color: #0a0a12; font-size: 9px; font-weight: 600;
      padding: 2px 6px; border-radius: 4px; white-space: nowrap;
      pointer-events: none; opacity: 0; transition: opacity 0.2s;
    }
    .ctx-export-tooltip.visible { opacity: 1; }
    @keyframes ctx-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    #empty-state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      background: #12121c;
    }
    .ctx-waveform { display: flex; align-items: center; gap: 3px; height: 24px; }
    .ctx-waveform span {
      width: 2px; background: #3a3a5a; border-radius: 1px;
      animation: ctx-wave 1.2s ease-in-out infinite;
    }
    .ctx-waveform span:nth-child(1) { animation-duration: 1.0s; }
    .ctx-waveform span:nth-child(2) { animation-duration: 0.8s; animation-delay: 0.15s; }
    .ctx-waveform span:nth-child(3) { animation-duration: 1.1s; animation-delay: 0.3s; }
    .ctx-waveform span:nth-child(4) { animation-duration: 0.9s; animation-delay: 0.45s; }
    @keyframes ctx-wave {
      0%, 100% { height: 8px; }
      50% { height: 20px; }
    }
    .ctx-empty-text { font-size: 11px; color: #6a6a8a; }
    #listening-indicator {
      display: none; align-items: center; gap: 6px;
      padding: 6px 16px; background: #12121c;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    #listening-indicator.visible { display: flex; }
    #listening-indicator .li-dot {
      width: 4px; height: 4px; border-radius: 50%; background: #5a5a7a;
      animation: li-pulse 2s ease-in-out infinite;
    }
    @keyframes li-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    #listening-indicator .li-text { font-size: 10px; color: #5a5a7a; }
    #transcript-strip {
      font-size: 9px; color: #2a2a3a; line-height: 16px; max-width: 100%;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      padding: 0 16px; flex-shrink: 0; display: none;
      -webkit-mask-image: linear-gradient(to right, black 70%, transparent 100%);
      mask-image: linear-gradient(to right, black 70%, transparent 100%);
    }
    #transcript-strip.visible { display: block; }
    #cards {
      flex: 1; overflow-y: auto; padding: 0; background: #12121c; display: none;
    }
    #cards::-webkit-scrollbar { width: 3px; }
    #cards::-webkit-scrollbar-track { background: transparent; }
    #cards::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
    .context-card {
      position: relative; padding: 8px 16px 8px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.03); border-left: 2px solid #4a4a6a;
      background: #181828; animation: ctx-card-in 0.25s ease-out both;
      cursor: pointer; user-select: none; overflow: hidden;
    }
    .context-card:hover { background: #1e1e32; }
    @keyframes ctx-card-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .context-card.collapsed { animation: none; cursor: default; }
    .card-row {
      display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;
    }
    .card-type {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; flex-shrink: 0;
      word-wrap: break-word; overflow-wrap: break-word; max-width: 100%;
    }
    .card-term {
      font-size: 13px; font-weight: 600; color: #e8e8f8;
      flex: 1; min-width: 0;
      white-space: normal; word-break: normal; overflow-wrap: normal;
    }
    .card-time { font-size: 10px; color: #4a4a5a; flex-shrink: 0; }
    .card-seen { font-size: 9px; color: #4a4a5a; flex-shrink: 0; }
    .card-rectx { font-size: 9px; color: #7070ff; flex-shrink: 0; }
    .context-card.recontextualized { border-left-color: #7070ff; background: rgba(112, 112, 255, 0.04); }
    .context-card.recontextualized:hover { background: rgba(112, 112, 255, 0.08); }
    .card-chevron {
      font-size: 12px; color: #3a3a5a; flex-shrink: 0;
      transition: transform 0.2s ease; line-height: 1;
    }
    .context-card.expanded .card-chevron { transform: rotate(90deg); }
    .card-expand-area { display: none; padding-top: 6px; }
    .context-card.expanded .card-expand-area { display: block; }
    .card-desc { font-size: 11px; color: #9a9ab0; line-height: 1.55; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }
    .card-thumbnail {
      width: 100%; max-height: 120px; object-fit: cover; border-radius: 6px;
      margin-bottom: 8px; opacity: 0; transition: opacity 0.3s ease;
    }
    .card-thumbnail.loaded { opacity: 1; }
    .card-source { font-size: 9px; color: #3a3a5a; margin-top: 4px; font-style: italic; }
    .card-popularity { font-size: 9px; color: #3a3a5a; margin-top: 4px; }
    .card-desc-loading::after {
      content: ''; display: inline-block; width: 4px; height: 4px;
      background: #6a6a8a; border-radius: 50%;
      animation: ctx-dot-pulse 1s ease-in-out infinite;
    }
    @keyframes ctx-dot-pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }
    .context-card.stock-card {
      background: #0f1a14; box-shadow: inset 2px 0 8px rgba(0, 230, 118, 0.15);
    }
    .context-card.stock-card:hover { background: #112218; }
    .stock-ticker { font-size: 18px; font-weight: 700; color: #e0e0f0; margin-bottom: 1px; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }
    .stock-company { font-size: 10px; color: #3a3a5a; margin-bottom: 8px; }
    .stock-price-row { display: flex; align-items: baseline; gap: 8px; }
    .stock-price { font-size: 16px; font-weight: 600; color: #e0e0f0; }
    .stock-change { font-size: 12px; font-weight: 600; }
    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }
    .reaction-row {
      display: flex; gap: 10px; margin-top: 10px; justify-content: flex-start;
    }
    .reaction-btn {
      width: 24px; height: 24px; border-radius: 50%; background: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; cursor: pointer; transition: opacity 0.3s, transform 0.2s;
      padding: 0; line-height: 1; flex-shrink: 0;
    }
    .reaction-btn:hover { transform: scale(1.15); }
    .reaction-known { border: 1px solid #6a6a8a; color: #6a6a8a; }
    .reaction-known:hover { background: rgba(106,106,138,0.15); }
    .reaction-new { border: 1px solid #00e676; color: #00e676; }
    .reaction-new:hover { background: rgba(0,230,118,0.1); }
    .reaction-advanced { border: 1px solid #ff9500; color: #ff9500; }
    .reaction-advanced:hover { background: rgba(255,149,0,0.1); }
    .reaction-label {
      font-size: 9px; color: #4a4a6a; margin-top: 2px; text-align: center;
    }
    .reaction-group { display: flex; flex-direction: column; align-items: center; }
    .context-card.reacted { opacity: 0.45; transition: opacity 0.4s; }
    .card-wiki-link {
      font-size: 10px; color: #3a3a5a; text-decoration: none;
      transition: color 0.15s; display: inline-block; margin-top: 4px;
    }
    .card-wiki-link:hover { color: #7a7aaa; }
    .card-shop-link {
      background: rgba(255,153,0,0.12); color: #FF9900; border-radius: 12px;
      padding: 3px 10px; font-size: 10px; text-decoration: none;
      display: inline-block; margin-top: 6px; transition: background 0.15s;
    }
    .card-shop-link:hover { background: rgba(255,153,0,0.22); }
    .feedback-msg { font-size: 11px; color: #3a3a5a; padding: 4px 0; text-align: center; }
    #missed-bar {
      display: none; padding: 6px 16px; background: #12121c;
      border-bottom: 1px solid rgba(255,255,255,0.03); flex-shrink: 0;
    }
    #missed-bar.visible { display: block; }
    #missed-btn {
      font-size: 10px; color: #00e676; background: rgba(0,230,118,0.08);
      border: none; border-radius: 12px; padding: 3px 10px;
      cursor: pointer; font-family: inherit; font-weight: 500;
      transition: background 0.15s;
    }
    #missed-btn:hover { background: rgba(0,230,118,0.15); }
    .context-card.missed { }
    .context-card.missed-glow {
      animation: missed-highlight 1.5s ease-out;
    }
    @keyframes missed-highlight {
      0% { box-shadow: inset 3px 0 10px rgba(0,230,118,0.3); }
      100% { box-shadow: none; }
    }

    /* ─── Preview card ─── */
    .ctx-preview-card {
      display: none; padding: 10px 16px; background: #12121f;
      border-left: 2px solid #5a5aff; border-bottom: 1px solid rgba(255,255,255,0.03);
      flex-shrink: 0;
    }
    .ctx-preview-card.visible { display: block; }
    .ctx-preview-title {
      font-size: 10px; font-weight: 600; color: #7070ff;
      margin-bottom: 6px;
    }
    .ctx-preview-term {
      font-size: 10px; color: #5a5a7a; line-height: 1.6;
    }

    /* ─── Ask bar ─── */
    .ctx-ask-bar {
      flex-shrink: 0; padding: 10px 12px; background: #161630;
      border-top: 1px solid rgba(255,255,255,0.04);
      box-shadow: 0 -4px 12px rgba(0,0,0,0.3);
    }
    .ctx-ask-input {
      width: 100%; height: 36px; background: #1e1e38;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      padding: 0 10px; font-size: 12px; color: #e0e0f0;
      font-family: inherit; outline: none;
      transition: border-color 0.2s;
    }
    .ctx-ask-input::placeholder { color: #6a6a8a; }
    .ctx-ask-input:focus { border-color: rgba(90,90,255,0.4); }
    .ctx-ask-response {
      display: none; padding: 10px 12px; font-size: 11px; color: #8a8aaa;
      line-height: 1.5; max-height: 150px; overflow-y: auto; background: #161630;
      border-top: 1px solid rgba(255,255,255,0.04); position: relative;
    }
    .ctx-ask-response.visible { display: block; }
    .ctx-ask-response::-webkit-scrollbar { width: 3px; }
    .ctx-ask-response::-webkit-scrollbar-track { background: transparent; }
    .ctx-ask-response::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
    .ctx-ask-clear {
      position: absolute; top: 6px; right: 8px;
      background: none; border: none; color: #3a3a5a; font-size: 10px;
      cursor: pointer; padding: 2px 4px; line-height: 1;
      transition: color 0.15s;
    }
    .ctx-ask-clear:hover { color: #8a8aaa; }
    .ctx-ask-loading::after {
      content: ''; display: inline-block; width: 4px; height: 4px;
      background: #6a6a8a; border-radius: 50%;
      animation: ctx-dot-pulse 1s ease-in-out infinite;
    }

    /* ─── Light theme overrides ─── */
    #sidebar.light-theme { background: #f5f5f8; color: #1a1a2e; }
    .light-theme #header { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.1); }
    .light-theme .ctx-wordmark { color: #1a1a2e; }
    .light-theme .ctx-close-btn, .light-theme .ctx-export-btn { color: #9a9ab0; }
    .light-theme .ctx-close-btn:hover, .light-theme .ctx-export-btn:hover { color: #5a5a70; background: rgba(0,0,0,0.05); }
    .light-theme #empty-state { background: #f5f5f8; }
    .light-theme .ctx-waveform span { background: #c0c0d0; }
    .light-theme .ctx-empty-text { color: #7a7a9a; }
    .light-theme #transcript-strip { color: #c0c0d0; }
    .light-theme #cards { background: #f5f5f8; }
    .light-theme #cards::-webkit-scrollbar-thumb { background: #d0d0e0; }
    .light-theme #listening-indicator { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme #listening-indicator .li-dot { background: #9a9ab0; }
    .light-theme #listening-indicator .li-text { color: #9a9ab0; }
    .light-theme #missed-bar { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme .context-card { background: #ffffff; border-bottom-color: rgba(0,0,0,0.06); }
    .light-theme .context-card:hover { background: #f0f0f5; }
    .light-theme .context-card.stock-card { background: #f0faf4; }
    .light-theme .context-card.stock-card:hover { background: #e8f5ee; }
    .light-theme .card-term { color: #1a1a2e; }
    .light-theme .card-time { color: #9a9ab0; }
    .light-theme .card-seen { color: #9a9ab0; }
    .light-theme .card-rectx { color: #5a5adf; }
    .light-theme .context-card.recontextualized { background: rgba(90, 90, 223, 0.05); }
    .light-theme .context-card.recontextualized:hover { background: rgba(90, 90, 223, 0.09); }
    .light-theme .card-chevron { color: #b0b0c0; }
    .light-theme .card-desc { color: #5a5a7a; }
    .light-theme .card-thumbnail { border: 1px solid rgba(0,0,0,0.06); }
    .light-theme .card-source { color: #b0b0c0; }
    .light-theme .card-popularity { color: #b0b0c0; }
    .light-theme .stock-ticker { color: #1a1a2e; }
    .light-theme .stock-company { color: #8a8aa0; }
    .light-theme .stock-price { color: #1a1a2e; }
    .light-theme .card-actions { }
    .light-theme .reaction-known { border-color: #b0b0c0; color: #b0b0c0; }
    .light-theme .reaction-label { color: #b0b0c0; }
    .light-theme .card-wiki-link { color: #8a8aa0; }
    .light-theme .card-wiki-link:hover { color: #5a5a70; }
    .light-theme .card-shop-link { background: rgba(255,153,0,0.1); }
    .light-theme .feedback-msg { color: #9a9ab0; }
    .light-theme .ctx-preview-card { background: #f0f0fa; }
    .light-theme .ctx-preview-title { color: #5a5adf; }
    .light-theme .ctx-preview-term { color: #8a8aa0; }
    .light-theme .ctx-ask-bar { background: #f5f5fa; border-top-color: rgba(0,0,0,0.06); box-shadow: 0 -4px 12px rgba(0,0,0,0.06); }
    .light-theme .ctx-ask-input { background: #ffffff; border-color: rgba(0,0,0,0.12); color: #1a1a2e; }
    .light-theme .ctx-ask-input::placeholder { color: #9a9ab0; }
    .light-theme .ctx-ask-input:focus { border-color: rgba(90,90,255,0.4); }
    .light-theme .ctx-ask-response { background: #f5f5fa; border-top-color: rgba(0,0,0,0.06); color: #5a5a7a; }
    .light-theme .ctx-ask-response::-webkit-scrollbar-thumb { background: #d0d0e0; }
    .light-theme .ctx-ask-clear { color: #b0b0c0; }
    .light-theme .ctx-ask-clear:hover { color: #5a5a70; }
    .ctx-session-summary {
      background: #161630; border: 1px solid rgba(90,90,255,0.15);
      border-radius: 10px; padding: 16px; margin: 12px;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .ctx-session-summary.visible { opacity: 1; }
    .ctx-session-summary-header {
      font-size: 13px; font-weight: 600; color: #e0e0f0; margin-bottom: 10px;
    }
    .ctx-session-summary-stats {
      font-size: 11px; color: #9a9ab0; line-height: 1.6;
    }
    .ctx-session-summary-export {
      background: rgba(90,90,255,0.15); color: #a0a0ff; border: none;
      border-radius: 8px; padding: 6px 14px; font-size: 11px;
      cursor: pointer; margin-top: 10px; font-family: inherit;
    }
    .ctx-session-summary-export:hover { background: rgba(90,90,255,0.25); }
    .ctx-session-summary-dismiss {
      display: block; font-size: 10px; color: #3a3a5a; margin-top: 8px;
      cursor: pointer; text-decoration: none; background: none; border: none;
      padding: 0; font-family: inherit;
    }
    .ctx-session-summary-dismiss:hover { color: #5a5a7a; }
    .light-theme .ctx-session-summary { background: #f0f0fa; border-color: rgba(90,90,255,0.12); }
    .light-theme .ctx-session-summary-header { color: #1a1a2e; }
    .light-theme .ctx-session-summary-stats { color: #5a5a7a; }
    .light-theme .ctx-session-summary-dismiss { color: #b0b0c0; }
  `;

  const BADGE_CSS = `
    :host { display: block; }
    .ctx-badge {
      width: 36px; height: 36px; border-radius: 50%;
      background: #1a1a2e; border: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: box-shadow 0.3s ease, border-color 0.3s;
      user-select: none; position: relative;
    }
    .ctx-badge:hover {
      border-color: rgba(255,255,255,0.15);
      background: #1e1e32;
    }
    .ctx-badge.pulse {
      animation: badge-glow 1.5s ease-out;
    }
    .ctx-badge.entity-flash {
      animation: badge-entity-flash 0.6s ease-out;
    }
    @keyframes badge-glow {
      0% { box-shadow: 0 0 12px rgba(0,230,118,0.4); }
      100% { box-shadow: none; }
    }
    @keyframes badge-entity-flash {
      0% { border-color: #00e676; box-shadow: 0 0 10px rgba(0,230,118,0.4); }
      100% { border-color: rgba(255,255,255,0.08); box-shadow: none; }
    }
    .ctx-badge-play {
      display: none; font-size: 12px; color: #6a6a8a; line-height: 1;
    }
    .ctx-badge.not-capturing .ctx-badge-play { display: block; }
    .ctx-badge.not-capturing .ctx-badge-count { display: none; }
    .ctx-badge.not-capturing .ctx-badge-waveform { display: none; }
    .ctx-badge-count {
      font-size: 13px; font-weight: 600; color: #e0e0f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1;
    }
    .ctx-badge.capturing .ctx-badge-count {
      position: absolute; top: -4px; right: -4px;
      font-size: 8px; background: #1a1a2e; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 50%; width: 16px; height: 16px;
      display: flex; align-items: center; justify-content: center;
    }
    .ctx-badge-waveform {
      display: none; align-items: center; justify-content: center; gap: 2px; height: 14px;
    }
    .ctx-badge.capturing .ctx-badge-waveform { display: flex; }
    .ctx-badge.capturing .ctx-badge-count { }
    .ctx-badge-bar {
      width: 2px; background: #00e676; border-radius: 1px;
      animation-timing-function: ease-in-out; animation-iteration-count: infinite;
      animation-direction: alternate;
    }
    .ctx-badge-bar:nth-child(1) { height: 4px; animation: wave1 0.6s ease-in-out infinite alternate; }
    .ctx-badge-bar:nth-child(2) { height: 7px; animation: wave2 0.45s ease-in-out infinite alternate; }
    .ctx-badge-bar:nth-child(3) { height: 5px; animation: wave3 0.55s ease-in-out infinite alternate; }
    .ctx-badge.paused .ctx-badge-bar { animation-play-state: paused; }
    @keyframes wave1 {
      0% { height: 4px; }
      100% { height: 10px; }
    }
    @keyframes wave2 {
      0% { height: 7px; }
      100% { height: 4px; }
    }
    @keyframes wave3 {
      0% { height: 5px; }
      100% { height: 9px; }
    }
    /* Light theme */
    .ctx-badge.light { background: #ffffff; border-color: rgba(0,0,0,0.08); }
    .ctx-badge.light:hover { background: #f5f5f8; border-color: rgba(0,0,0,0.12); }
    .ctx-badge.light .ctx-badge-count { color: #1a1a2e; }
    .ctx-badge.light.capturing .ctx-badge-count { background: #ffffff; border-color: rgba(0,0,0,0.1); }
    .ctx-badge.light .ctx-badge-play { color: #b0b0c0; }
  `;

  const TOAST_CSS = `
    :host { display: block; }
    .ctx-toast {
      background: #1a1a2e; border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px; padding: 8px 12px; border-left: 3px solid #4a4a6a;
      cursor: pointer; opacity: 0; transition: opacity 0.3s ease;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 200px;
    }
    .ctx-toast.visible { opacity: 1; pointer-events: auto; }
    .ctx-toast.fading { opacity: 0; transition: opacity 0.5s ease; }
    .ctx-toast-term {
      font-size: 12px; font-weight: 600; color: #e0e0f0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ctx-toast.light {
      background: #ffffff; border-color: rgba(0,0,0,0.06);
    }
    .ctx-toast.light .ctx-toast-term { color: #1a1a2e; }
  `;

  function ensureBadge() {
    if (badgeShadow) return;

    badgeEl = document.createElement('div');
    badgeEl.id = 'context-badge-host';
    badgeEl.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';

    badgeShadow = badgeEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    badgeShadow.appendChild(style);

    const badge = document.createElement('div');
    badge.className = 'ctx-badge';
    badge.innerHTML = '<span class="ctx-badge-play">\u25B6</span><div class="ctx-badge-waveform"><div class="ctx-badge-bar"></div><div class="ctx-badge-bar"></div><div class="ctx-badge-bar"></div></div><span class="ctx-badge-count">0</span>';
    badge.addEventListener('click', () => {
      ensureSidebar();
      if (hostEl && hostEl.dataset.open === 'true') {
        closeSidebar();
      } else {
        openSidebar();
        resetAutoHide();
      }
    });
    badgeShadow.appendChild(badge);
    document.body.appendChild(badgeEl);

    // Set initial badge state based on capturing flag
    chrome.storage.local.get('capturing', (data) => {
      if (data.capturing) {
        setBadgeCapturing(true, false);
      } else {
        badge.classList.add('not-capturing');
      }
    });
  }

  function updateBadge(newCards) {
    if (!badgeShadow) return;
    const countEl = badgeShadow.querySelector('.ctx-badge-count');
    if (countEl) countEl.textContent = termCount;

    if (newCards > 0) {
      const badge = badgeShadow.querySelector('.ctx-badge');
      if (badge) {
        badge.classList.remove('entity-flash');
        void badge.offsetWidth;
        badge.classList.add('entity-flash');
      }
    }
  }

  function setBadgeCapturing(capturing, paused) {
    if (!badgeShadow) return;
    const badge = badgeShadow.querySelector('.ctx-badge');
    if (!badge) return;
    badge.classList.toggle('capturing', capturing);
    badge.classList.toggle('not-capturing', !capturing);
    badge.classList.toggle('paused', capturing && paused);
  }

  let toastTimer = null;
  let toastHost = null;
  let toastShadow = null;

  function ensureToastHost() {
    if (toastShadow) return;
    toastHost = document.createElement('div');
    toastHost.id = 'context-toast-host';
    toastHost.style.cssText = 'position:fixed;bottom:65px;right:20px;z-index:2147483647;';
    toastShadow = toastHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    toastShadow.appendChild(style);
    document.body.appendChild(toastHost);
  }

  function showToast(entity) {
    // Strict check: never show if sidebar is open
    if (hostEl && hostEl.dataset.open === 'true') return;

    ensureToastHost();

    // Remove existing toast
    const existing = toastShadow.querySelector('.ctx-toast');
    if (existing) existing.remove();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    const color = getTypeColor(entity.type);
    const toast = document.createElement('div');
    toast.className = 'ctx-toast' + (isLightTheme ? ' light' : '');
    toast.style.borderLeftColor = color;
    toast.innerHTML = `<div class="ctx-toast-term">${escapeHtml(entity.term || entity.name || '')}</div>`;
    toast.addEventListener('click', () => {
      toast.remove();
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      ensureSidebar();
      openSidebar();
      resetAutoHide();
    });
    toastShadow.appendChild(toast);

    // Fade in
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });

    // Fade out after 3s
    toastTimer = setTimeout(() => {
      toast.classList.add('fading');
      toast.classList.remove('visible');
      setTimeout(() => { toast.remove(); }, 500);
      toastTimer = null;
    }, 3000);
  }

  let isLightTheme = false;

  function getHostPosition() {
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    const borderColor = isLightTheme ? '#e0e0e8' : '#1e1e2e';
    const border = pos === 'right' ? `border-left:1px solid ${borderColor};` : `border-right:1px solid ${borderColor};`;
    const bg = isLightTheme ? '#f5f5f8' : '#12121c';
    const translate = pos === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    return `position:fixed;top:0;${pos}:0;width:280px;height:100vh;z-index:2147483647;overflow:hidden;${border}background:${bg};transform:${translate};transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);margin:0;padding:0;`;
  }

  function applySidebarPosition() {
    if (!hostEl) return;
    const isOpen = hostEl.dataset.open === 'true';
    hostEl.style.cssText = getHostPosition();
    if (isOpen) hostEl.style.transform = 'translateX(0)';
  }

  function openSidebar() {
    if (!hostEl) return;
    hostEl.dataset.open = 'true';
    hostEl.style.transform = 'translateX(0)';
  }

  function closeSidebar() {
    if (!hostEl) return;
    hostEl.dataset.open = 'false';
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    hostEl.style.transform = pos === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
  }

  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (settings.autoHide && hostEl) {
      autoHideTimer = setTimeout(() => closeSidebar(), 30000);
    }
  }

  function addCardButtons(card, key, entity) {
    const expandArea = card.querySelector('.card-expand-area');
    if (!expandArea) return;

    const row = document.createElement('div');
    row.className = 'reaction-row';

    const reactions = [
      { cls: 'reaction-known', icon: '\u2713', label: 'Knew this', reaction: 'known' },
      { cls: 'reaction-new', icon: '\u2605', label: 'New to me', reaction: 'new' },
      { cls: 'reaction-advanced', icon: '?', label: 'Too advanced', reaction: 'advanced' }
    ];

    reactions.forEach(({ cls, icon, label, reaction }) => {
      const group = document.createElement('div');
      group.className = 'reaction-group';
      const btn = document.createElement('button');
      btn.className = `reaction-btn ${cls}`;
      btn.textContent = icon;
      btn.title = label;
      const labelEl = document.createElement('div');
      labelEl.className = 'reaction-label';
      labelEl.textContent = label;
      group.appendChild(btn);
      group.appendChild(labelEl);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.storage.local.get('cardReactions', (data) => {
          const reactions = data.cardReactions || [];
          reactions.push({ term: key, type: entity.type || 'other', reaction, timestamp: Date.now() });
          chrome.storage.local.set({ cardReactions: reactions });
        });
        card.classList.add('reacted');
        setTimeout(() => {
          card.classList.remove('expanded');
        }, 500);
      });

      row.appendChild(group);
    });

    expandArea.appendChild(row);
  }

  const SHOP_KEYWORDS = /fishing|cooking|recipe|review|setup|gear|tools|build|diy|tutorial|beginner|how\s*to|unboxing/i;
  const EXCLUDE_KEYWORDS = /history|politics|war|battle|election|president|congress|military|wwi|wwii|world\s*war/i;
  const SHOP_ENTITY_TYPES = new Set(['concept', 'organization', 'stock']);
  const EXCLUDE_ENTITY_TYPES = new Set(['person', 'people', 'event']);

  function shouldShowShopLink(entity, videoTitle) {
    const type = (entity.type || '').toLowerCase();
    if (EXCLUDE_ENTITY_TYPES.has(type)) return false;
    if (EXCLUDE_KEYWORDS.test(videoTitle)) return false;
    if (type === 'stock') return true;
    if (SHOP_ENTITY_TYPES.has(type) && SHOP_KEYWORDS.test(videoTitle)) return true;
    return false;
  }

  function getShopLinkHTML(entity, videoTitle) {
    if (!shouldShowShopLink(entity, videoTitle)) return '';
    const term = entity.term || entity.name || '';
    const href = 'https://www.amazon.com/s?k=' + encodeURIComponent(term) + '&tag=contextlis-20';
    return '<a class="card-shop-link" href="' + href + '" target="_blank" rel="noopener">Shop on Amazon &#x2197;</a>';
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card stock-card expanded';
    const color = getTypeColor('stock');
    card.style.borderLeftColor = color;

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const timestamp = formatTime(new Date());

    let expandContent;
    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changeClass = changeVal >= 0 ? 'positive' : 'negative';
      const changePrefix = changeVal >= 0 ? '+' : '';
      expandContent = `
        <div class="stock-company">${companyName}</div>
        <div class="stock-price-row">
          <span class="stock-price">$${price.toFixed(2)}</span>
          <span class="stock-change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}</span>
        </div>
      `;
    } else {
      expandContent = `
        <div class="stock-company">${companyName}</div>
        ${entity.description ? `<div class="card-desc">${escapeHtml(firstSentence(entity.description))}</div>` : ''}
      `;
    }

    card.innerHTML = `
      <div class="card-row">
        <span class="card-type" style="color:${color}">STOCK</span>
        <span class="card-term">${ticker}</span>
        <span class="card-time">${timestamp}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      <div class="card-expand-area">${expandContent}</div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a')) return;
      card.classList.toggle('expanded');
    });

    // Inject shop link for stock cards
    chrome.storage.local.get('capturingTabTitle', (data) => {
      const videoTitle = data.capturingTabTitle || document.title || '';
      const shopHTML = getShopLinkHTML(entity, videoTitle);
      if (shopHTML) {
        const expandArea = card.querySelector('.card-expand-area');
        if (expandArea) expandArea.insertAdjacentHTML('beforeend', shopHTML);
      }
    });

    const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
    addCardButtons(card, key, entity);
    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';
    const type = entity.type || 'other';
    const color = getTypeColor(type);
    const isRectx = !!entity.recontextualized;

    if (isRectx) {
      card.classList.add('recontextualized');
    } else {
      card.style.borderLeftColor = color;
    }

    const timestamp = formatTime(new Date());
    const typeLabel = (type || 'OTHER').toUpperCase();
    const termText = escapeHtml(entity.term || entity.name || '');

    const wikiTerm = (entity.term || entity.name || '').replace(/ /g, '_');
    const wikiUrl = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(wikiTerm);

    const typeBadge = isRectx
      ? `<span class="card-type" style="color:#7070ff">&#x21BB; ${typeLabel}</span><span class="card-rectx">new context</span>`
      : `<span class="card-type" style="color:${color}">${typeLabel}</span>`;
    const seenTag = !isRectx && entity._kbSeen ? '<span class="card-seen">seen before</span>' : '';

    const sourceLine = isRectx && entity._kbSource
      ? '<div class="card-source">Previously seen in: ' + escapeHtml(entity._kbSource) + '</div>'
      : (entity._kbSource ? '<div class="card-source">Also came up in: ' + escapeHtml(entity._kbSource) + '</div>' : '');

    card.innerHTML = `
      <div class="card-row">
        ${typeBadge}
        <span class="card-term">${termText}</span>
        ${seenTag}
        <span class="card-time">${timestamp}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      <div class="card-expand-area">
        <div class="card-desc"></div>
        ${sourceLine}
        <a class="card-wiki-link" href="${wikiUrl}" target="_blank" rel="noopener">Wikipedia &#x2197;</a>
      </div>
    `;

    // Inject shop link for eligible generic cards
    chrome.storage.local.get('capturingTabTitle', (data) => {
      const videoTitle = data.capturingTabTitle || document.title || '';
      const shopHTML = getShopLinkHTML(entity, videoTitle);
      if (shopHTML) {
        const expandArea = card.querySelector('.card-expand-area');
        if (expandArea) expandArea.insertAdjacentHTML('beforeend', shopHTML);
      }
    });

    let descFetched = false;
    const inlineDesc = entity.description || '';
    const termName = entity.term || entity.name || '';

    function saveDescToKB(desc) {
      chrome.storage.local.get(['knowledgeBase', 'capturingTabTitle'], (kbData) => {
        const kb = kbData.knowledgeBase || {};
        const source = kbData.capturingTabTitle || document.title || '';
        const key = termName.toLowerCase();
        if (kb[key]) {
          kb[key].description = desc;
          if (!kb[key].source) kb[key].source = source;
        } else {
          kb[key] = { term: termName, type: entity.type || 'other', firstSeen: Date.now(), timesSeen: 1, expanded: true, source, description: desc };
        }
        chrome.storage.local.set({ knowledgeBase: kb });
      });
    }

    function saveDescToHistory(desc) {
      chrome.storage.local.get('sessionHistory', (hData) => {
        const history = hData.sessionHistory || [];
        const entry = history.find(h => h.term === termName && !h.description);
        if (entry) {
          entry.description = desc;
          chrome.storage.local.set({ sessionHistory: history });
        }
      });
    }

    // If entity arrived with a description, pre-fill it
    if (inlineDesc) {
      descFetched = true;
      const descEl = card.querySelector('.card-desc');
      const desc = firstSentence(inlineDesc);
      descEl.textContent = desc;
      saveDescToHistory(desc);
      saveDescToKB(desc);
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a')) return;
      card.classList.toggle('expanded');

      if (card.classList.contains('expanded') && !descFetched) {
        descFetched = true;
        const descEl = card.querySelector('.card-desc');
        descEl.classList.add('card-desc-loading');

        // Check knowledgeBase cache first
        chrome.storage.local.get(['knowledgeBase', 'userProfile'], (data) => {
          const kb = data.knowledgeBase || {};
          const kbEntry = kb[termName.toLowerCase()];
          if (kbEntry && kbEntry.description) {
            descEl.classList.remove('card-desc-loading');
            descEl.textContent = kbEntry.description;
            saveDescToHistory(kbEntry.description);
            return;
          }

          // No cached description, fetch from API
          try { if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'CONTEXT_FETCH' }); } catch (e) {}
          fetch('https://context-extension-zv8d.vercel.app/api/context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              term: termName,
              userProfile: data.userProfile || null
            })
          })
          .then(res => res.ok ? res.json() : Promise.reject(res))
          .then(contextData => {
            descEl.classList.remove('card-desc-loading');
            const desc = firstSentence(contextData.description || '');
            descEl.textContent = desc;
            saveDescToHistory(desc);
            saveDescToKB(desc);
          })
          .catch(() => {
            descEl.classList.remove('card-desc-loading');
            descEl.textContent = 'Could not load description';
          });
        });
      }

      // Fetch Wikipedia thumbnail on first expand (only for specific people/orgs/events, not concepts)
      if (card.classList.contains('expanded') && !card.dataset.thumbUrl && !card.dataset.thumbChecked) {
        card.dataset.thumbChecked = 'true';
        const termForWiki = entity.term || entity.name || '';
        const entityType = (entity.type || '').toLowerCase();
        const commonWords = ['the','a','an','of','in','on','at','to','for','and','or','is','was','are','were','be','been','being','have','has','had','do','does','did','will','would','shall','should','may','might','can','could','must','not','no','but','so','if','then','than','that','this','these','those','with','from','by','as','into','through','during','before','after','above','below','between','under','over','out','up','down','off','about','each','every','all','both','few','more','most','other','some','such','new','old','high','low','big','great','small','long','large','first','last','early','young','good','bad','right','left','next','free','full','real','true','best','same','much','many','own','just','little','only','still','also','very'];
        const isGenericPlace = /^(france|britain|spain|germany|italy|china|japan|russia|india|america|usa|uk|england|europe|asia|africa|australia|paris|london|rome|berlin|tokyo|new york|moscow|beijing|washington|madrid|vienna|amsterdam|brussels|stockholm|oslo|dublin|lisbon|athens|cairo|istanbul|mumbai|shanghai|sydney|toronto|mexico|brazil|egypt|turkey|poland|portugal|greece|norway|sweden|denmark|finland|switzerland|austria|netherlands|belgium|ireland|scotland|wales|zimbabwe|weimar germany)$/i;
        let shouldFetchThumb = true;
        if (entityType === 'concept') {
          shouldFetchThumb = false;
        } else if (entityType === 'person') {
          shouldFetchThumb = true;
        } else if (entityType === 'organization' || entityType === 'event') {
          // Only fetch if term contains a proper noun (capitalized, not a common word)
          const words = termForWiki.split(/\s+/);
          const hasProperNoun = words.some(w => /^[A-Z]/.test(w) && !commonWords.includes(w.toLowerCase()));
          shouldFetchThumb = hasProperNoun;
        } else {
          shouldFetchThumb = false;
        }
        if (isGenericPlace.test(termForWiki.trim())) {
          shouldFetchThumb = false;
        }
        shouldFetchThumb && fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(termForWiki))
          .then(r => r.ok ? r.json() : null)
          .then(wikiData => {
            if (wikiData && wikiData.thumbnail && wikiData.thumbnail.source && !wikiData.thumbnail.source.includes('/Flag_of')) {
              card.dataset.thumbUrl = wikiData.thumbnail.source;
              const img = document.createElement('img');
              img.className = 'card-thumbnail';
              img.src = wikiData.thumbnail.source;
              img.alt = termForWiki;
              img.addEventListener('load', () => img.classList.add('loaded'));
              const expandArea = card.querySelector('.card-expand-area');
              expandArea.insertBefore(img, expandArea.firstChild);
            }
          })
          .catch(() => {});
      }

      // Track popularity on first expand
      if (card.classList.contains('expanded') && !card.dataset.popChecked) {
        card.dataset.popChecked = 'true';
        const termName = entity.term || entity.name || '';
        fetch('https://context-extension-zv8d.vercel.app/api/popularity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoUrl: window.location.href, term: termName })
        })
        .then(r => r.ok ? r.json() : null)
        .then(popData => {
          if (popData && popData.count > 5) {
            const expandArea = card.querySelector('.card-expand-area');
            const popEl = document.createElement('div');
            popEl.className = 'card-popularity';
            popEl.textContent = '\uD83D\uDD25 frequently explored';
            const wikiLink = expandArea.querySelector('.card-wiki-link');
            expandArea.insertBefore(popEl, wikiLink);
          }
        })
        .catch(() => {});
      }
    });

    const key = (entity.term || entity.name || '').toLowerCase();
    addCardButtons(card, key, entity);
    return card;
  }

  function ensureSidebar() {
    if (shadowRoot) return shadowRoot.getElementById('cards');

    // Host element — inline styles so YouTube can't override positioning
    hostEl = document.createElement('div');
    hostEl.id = 'context-sidebar-host';
    hostEl.style.cssText = getHostPosition();

    // Shadow DOM — YouTube CSS cannot cross this boundary
    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    // Styles inside shadow root (completely isolated)
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadowRoot.appendChild(style);

    // Sidebar wrapper
    const sidebar = document.createElement('div');
    sidebar.id = 'sidebar';

    // Header
    const header = document.createElement('div');
    header.id = 'header';
    header.innerHTML = `
      <span class="ctx-wordmark">context</span>
      <div class="ctx-header-right">
        <div class="ctx-live">
          <span class="ctx-live-dot"></span>
          <span class="ctx-live-text">Live</span>
        </div>
        <button class="ctx-export-btn" title="Copy study guide">&#x1F4CB;<span class="ctx-export-tooltip">Copied!</span></button>
        <button class="ctx-close-btn" title="Close sidebar">&#x2715;</button>
      </div>
    `;

    // Wire up close button
    header.querySelector('.ctx-close-btn').addEventListener('click', () => {
      closeSidebar();
    });

    // Wire up export button
    header.querySelector('.ctx-export-btn').addEventListener('click', () => {
      const title = document.title || 'Untitled';
      const url = window.location.href;

      chrome.storage.local.get('sessionHistory', (data) => {
        const history = data.sessionHistory || [];
        let md = `# ${title}\n${url}\n\n## Key Terms\n\n`;
        history.forEach(entry => {
          const type = (entry.type || 'other').charAt(0).toUpperCase() + (entry.type || 'other').slice(1);
          md += `**${entry.term}** (${type})\n`;
          if (entry.description) md += `${entry.description}\n`;
          md += '\n';
        });

        navigator.clipboard.writeText(md.trim()).then(() => {
          const tooltip = header.querySelector('.ctx-export-tooltip');
          tooltip.classList.add('visible');
          setTimeout(() => tooltip.classList.remove('visible'), 1500);
        });
      });
    });

    // Empty state
    const emptyState = document.createElement('div');
    emptyState.id = 'empty-state';
    emptyState.innerHTML = `
      <div class="ctx-waveform"><span></span><span></span><span></span><span></span></div>
      <div class="ctx-empty-text">Listening for context...</div>
    `;

    // "What did I miss?" bar
    const missedBar = document.createElement('div');
    missedBar.id = 'missed-bar';
    missedBar.innerHTML = '<button id="missed-btn">What did I miss?</button>';
    missedBar.querySelector('#missed-btn').addEventListener('click', () => {
      const cardsEl = shadowRoot.getElementById('cards');
      const missedCards = cardsEl.querySelectorAll('.context-card.missed');
      if (missedCards.length > 0) {
        // Scroll to the oldest missed card (last in DOM since prepended)
        const oldest = missedCards[missedCards.length - 1];
        oldest.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Glow all missed cards
        missedCards.forEach(c => {
          c.classList.add('missed-glow');
          c.classList.remove('missed');
        });
        // Clean up after animation
        setTimeout(() => {
          cardsEl.querySelectorAll('.missed-glow').forEach(c => c.classList.remove('missed-glow'));
        }, 1500);
      }
      missedBar.classList.remove('visible');
    });

    // Listening indicator
    const listeningIndicator = document.createElement('div');
    listeningIndicator.id = 'listening-indicator';
    listeningIndicator.innerHTML = '<span class="li-dot"></span><span class="li-text">Listening for new terms...</span>';

    // Preview card (knowledge base match)
    const previewCard = document.createElement('div');
    previewCard.className = 'ctx-preview-card';

    // Cards container
    const cardContainer = document.createElement('div');
    cardContainer.id = 'cards';

    // Check knowledgeBase for terms related to page title
    chrome.storage.local.get('knowledgeBase', (kbData) => {
      const kb = kbData.knowledgeBase || {};
      const entries = Object.values(kb);
      if (entries.length === 0) return;

      const title = document.title.toLowerCase();
      const matches = entries.filter(e => {
        const term = (e.term || '').toLowerCase();
        return term.length >= 3 && title.includes(term);
      });

      if (matches.length >= 2) {
        const shown = matches.slice(0, 3);
        let html = '<div class="ctx-preview-title">You\'ve explored related topics before</div>';
        shown.forEach(m => {
          const source = m.source ? ' (from ' + escapeHtml(m.source) + ')' : '';
          html += '<div class="ctx-preview-term">' + escapeHtml(m.term) + source + '</div>';
        });
        previewCard.innerHTML = html;
        previewCard.classList.add('visible');
      }
    });

    // Ask response area
    const askResponse = document.createElement('div');
    askResponse.className = 'ctx-ask-response';

    const askClear = document.createElement('button');
    askClear.className = 'ctx-ask-clear';
    askClear.textContent = '\u2715';
    askClear.addEventListener('click', () => {
      askResponse.textContent = '';
      askResponse.classList.remove('visible');
    });

    // Ask bar
    const askBar = document.createElement('div');
    askBar.className = 'ctx-ask-bar';
    const askInput = document.createElement('input');
    askInput.className = 'ctx-ask-input';
    askInput.type = 'text';
    askInput.placeholder = 'Ask about this video...';
    askBar.appendChild(askInput);

    askInput.addEventListener('focus', () => {
      if (askInput.dataset.hasSuggestion === 'true' && !askInput.value) {
        askInput.placeholder = 'Ask about this video...';
        askInput.dataset.hasSuggestion = 'false';
      }
    });

    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const typed = askInput.value.trim();
        const question = typed || (askInput.dataset.hasSuggestion === 'true' ? askInput.placeholder : '');
        if (!question || question === 'Ask about this video...') return;
        askInput.value = '';
        askInput.placeholder = 'Ask about this video...';
        askInput.dataset.hasSuggestion = 'false';

        askResponse.textContent = '';
        askResponse.classList.add('visible', 'ctx-ask-loading');
        askResponse.appendChild(askClear);

        chrome.storage.local.get(['sessionTranscript', 'capturingTabTitle'], (data) => {
          fetch('https://context-extension-zv8d.vercel.app/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question,
              sessionTranscript: data.sessionTranscript || '',
              videoTitle: data.capturingTabTitle || document.title || ''
            })
          })
          .then(res => res.ok ? res.json() : Promise.reject(res))
          .then(result => {
            askResponse.classList.remove('ctx-ask-loading');
            askResponse.textContent = result.answer || 'No answer available';
            askResponse.appendChild(askClear);
          })
          .catch(() => {
            askResponse.classList.remove('ctx-ask-loading');
            askResponse.textContent = 'Could not get an answer';
            askResponse.appendChild(askClear);
          });
        });
      }
    });

    // Transcript strip — ambient "audio is being heard" indicator
    const transcriptStrip = document.createElement('div');
    transcriptStrip.id = 'transcript-strip';

    sidebar.appendChild(header);
    sidebar.appendChild(transcriptStrip);
    sidebar.appendChild(missedBar);
    sidebar.appendChild(listeningIndicator);
    sidebar.appendChild(previewCard);
    sidebar.appendChild(emptyState);
    sidebar.appendChild(cardContainer);
    sidebar.appendChild(askResponse);
    sidebar.appendChild(askBar);
    shadowRoot.appendChild(sidebar);
    document.body.appendChild(hostEl);

    ensureBadge();
    applyTheme();
    console.log('[CONTENT] Shadow DOM sidebar created');
    return cardContainer;
  }

  function showCardsHideEmpty() {
    if (hasCards || !shadowRoot) return;
    hasCards = true;
    const empty = shadowRoot.getElementById('empty-state');
    const cards = shadowRoot.getElementById('cards');
    if (empty) empty.style.display = 'none';
    if (cards) cards.style.display = 'block';
  }

  function trackSessionStart(timestamp) {
    if (timestamp === lastSessionStart) return;
    lastSessionStart = timestamp;
  }

  function resetSidebar() {
    hasCards = false;
    termCount = 0;
    seenTerms.clear();
    lastRenderedTerm = '';
    if (askIdleTimer) { clearTimeout(askIdleTimer); askIdleTimer = null; }
    if (listeningTimer) { clearTimeout(listeningTimer); listeningTimer = null; }

    if (shadowRoot) {
      const cards = shadowRoot.getElementById('cards');
      if (cards) {
        cards.innerHTML = '';
        cards.style.display = 'none';
      }
      const empty = shadowRoot.getElementById('empty-state');
      if (empty) empty.style.display = '';
      const li = shadowRoot.getElementById('listening-indicator');
      if (li) li.classList.remove('visible');
      // Clear any session summary
      const summary = shadowRoot.querySelector('.ctx-session-summary');
      if (summary) summary.remove();
      // Reset ask bar
      const askInput = shadowRoot.querySelector('.ctx-ask-input');
      if (askInput) {
        askInput.value = '';
        askInput.placeholder = 'Ask about this video...';
        askInput.dataset.hasSuggestion = 'false';
      }
      const askResponse = shadowRoot.querySelector('.ctx-ask-response');
      if (askResponse) {
        askResponse.textContent = '';
        askResponse.classList.remove('visible');
      }
    }

    // Update badge count
    if (badgeShadow) {
      const countEl = badgeShadow.querySelector('.ctx-badge-count');
      if (countEl) countEl.textContent = '0';
    }

    console.log('[CONTENT] Sidebar state reset for new session');
  }

  function resetAskIdleTimer() {
    if (askIdleTimer) clearTimeout(askIdleTimer);
    askIdleTimer = setTimeout(() => {
      if (!shadowRoot || !lastRenderedTerm) return;
      const input = shadowRoot.querySelector('.ctx-ask-input');
      if (!input || input === shadowRoot.activeElement || input.value.trim()) return;
      const suggestions = [
        `Try: What is ${lastRenderedTerm}?`,
        `Try: Why is ${lastRenderedTerm} important?`
      ];
      input.placeholder = suggestions[askSuggestionCount % 2];
      input.dataset.hasSuggestion = 'true';
      askSuggestionCount++;
    }, 20000);
  }

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards received:', entities.map(e => e.term));

    ensureSidebar();
    const cards = shadowRoot.getElementById('cards');

    const now = Date.now();

    for (const [key, ts] of seenTerms) {
      if (now - ts > DEDUP_WINDOW) seenTerms.delete(key);
    }

    entities = entities.filter(entity => {
      const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
      if (!key) return false;
      if (ignoreList.has(key)) {
        console.log('[CONTENT] Ignored:', key);
        return false;
      }
      if (seenTerms.has(key) && now - seenTerms.get(key) < DEDUP_WINDOW) {
        console.log('[CONTENT] Dedup skipped:', key);
        return false;
      }
      seenTerms.set(key, now);
      return true;
    });

    console.log('[CONTENT] After dedup filter:', entities.map(e => e.term));
    console.log('[CONTENT] Rendering entities:', entities.map(e => e.term));

    if (entities.length === 0) return;

    // Check knowledge base for seen-before terms
    chrome.storage.local.get(['knowledgeBase', 'capturingTabTitle'], (kbData) => {
      const kb = kbData.knowledgeBase || {};
      const currentTitle = kbData.capturingTabTitle || document.title || '';

      // Filter out terms seen 3+ times, annotate 1-2 times
      entities = entities.filter(entity => {
        const term = (entity.term || entity.name || '').toLowerCase();
        const entry = kb[term];
        if (entry && entry.timesSeen >= 3 && !entity.recontextualized) {
          console.log('[CONTENT] KB skip (seen', entry.timesSeen, 'times):', term);
          return false;
        }
        if (entry) {
          if (!entity.recontextualized) entity._kbSeen = true;
          if (entry.source && entry.source !== currentTitle) {
            entity._kbSource = entry.source;
          }
        }
        return true;
      });

      if (entities.length === 0) return;

      renderCardsInner(entities, cards);
    });
  }

  function renderCardsInner(entities, cards) {

    showCardsHideEmpty();

    // Hide listening indicator and reset timer (only show after cards exist)
    if (shadowRoot) {
      const li = shadowRoot.getElementById('listening-indicator');
      if (li) li.classList.remove('visible');
    }
    if (listeningTimer) clearTimeout(listeningTimer);
    if (hasCards) {
      listeningTimer = setTimeout(() => {
        if (shadowRoot && hasCards) {
          const li = shadowRoot.getElementById('listening-indicator');
          if (li) li.classList.add('visible');
        }
      }, 20000);
    }

    const limited = entities.slice(0, settings.cardsPerChunk);
    const sidebarClosed = !hostEl || hostEl.dataset.open !== 'true';

    limited.forEach(entity => {
      const card = entity.type === 'stock'
        ? createStockCard(entity)
        : createGenericCard(entity);

      if (sidebarClosed) card.classList.add('missed');
      cards.prepend(card);
      termCount++;
      console.log('[CONTENT] Card added:', entity.ticker || entity.term || entity.name);
    });

    // Show "What did I miss?" if enough missed cards
    if (sidebarClosed && shadowRoot) {
      const missedCount = cards.querySelectorAll('.context-card.missed').length;
      const mb = shadowRoot.getElementById('missed-bar');
      if (mb) mb.classList.toggle('visible', missedCount > 3);
    }

    updateBadge(limited.length);

    // Show toast for first entity if sidebar is closed
    if (hostEl && hostEl.dataset.open !== 'true' && limited.length > 0) {
      showToast(limited[0]);
    }

    chrome.storage.local.remove('pendingEntities');

    // Track last term and reset ask idle timer
    if (limited.length > 0) {
      lastRenderedTerm = limited[0].term || limited[0].name || '';
      resetAskIdleTimer();
    }
  }

  // Listen for future updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sessionTranscript && shadowRoot) {
      const strip = shadowRoot.getElementById('transcript-strip');
      if (strip) {
        const text = changes.sessionTranscript.newValue || '';
        const last40 = text.slice(-120);
        strip.textContent = last40;
        strip.classList.toggle('visible', text.length > 0);
      }
    }
    if (changes.sessionStart && changes.sessionStart.newValue) {
      isActiveTab((active) => {
        if (active) {
          trackSessionStart(changes.sessionStart.newValue);
          resetSidebar();
        }
      });
    }
    if (changes.capturing) {
      if (changes.capturing.newValue === true) {
        ensureBadge();
        setBadgeCapturing(true, false);
      } else if (changes.capturing.newValue === false) {
        setBadgeCapturing(false, false);
      }
    }
    if (changes.capturing && changes.capturing.oldValue === true && changes.capturing.newValue === false) {
      isActiveTab((active) => {
        if (!active) return;
        chrome.storage.local.get(['sessionHistory', 'knowledgeBase', 'capturingTabTitle'], (data) => {
          const history = data.sessionHistory || [];
          const kb = data.knowledgeBase || {};
          const title = data.capturingTabTitle || document.title || 'Untitled Video';
          const totalTerms = history.length;
          const expanded = history.filter(h => h.description).length;
          const knownCount = history.filter(h => {
            const key = (h.term || '').toLowerCase();
            return kb[key] && kb[key].timesSeen > 1;
          }).length;

          const cardsContainer = shadowRoot ? shadowRoot.getElementById('cards') : null;
          if (!cardsContainer) return;

          // Remove any existing summary
          const existing = cardsContainer.querySelector('.ctx-session-summary');
          if (existing) existing.remove();

          const summaryEl = document.createElement('div');
          summaryEl.className = 'ctx-session-summary';
          summaryEl.innerHTML = `
            <div class="ctx-session-summary-header">Session complete</div>
            <div class="ctx-session-summary-stats">
              ${totalTerms} terms detected<br>
              ${expanded} expanded by you<br>
              ${knownCount} previously known
            </div>
            <button class="ctx-session-summary-export">Export study guide</button>
            <button class="ctx-session-summary-dismiss">Dismiss</button>
          `;

          summaryEl.querySelector('.ctx-session-summary-export').addEventListener('click', (e) => {
            e.stopPropagation();
            let guide = `STUDY GUIDE: ${title}\n${'='.repeat(40)}\n\n`;
            const grouped = {};
            history.forEach(entry => {
              const t = (entry.type || 'other').toUpperCase();
              if (!grouped[t]) grouped[t] = [];
              grouped[t].push(entry);
            });
            Object.keys(grouped).sort().forEach(type => {
              guide += `${type}\n`;
              grouped[type].forEach(ent => {
                guide += `  ${ent.term}${ent.description ? ' — ' + ent.description : ''}\n`;
              });
              guide += '\n';
            });
            navigator.clipboard.writeText(guide.trim()).then(() => {
              const btn = summaryEl.querySelector('.ctx-session-summary-export');
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Export study guide'; }, 1500);
            });
          });

          summaryEl.querySelector('.ctx-session-summary-dismiss').addEventListener('click', (e) => {
            e.stopPropagation();
            summaryEl.remove();
          });

          cardsContainer.appendChild(summaryEl);
          requestAnimationFrame(() => {
            summaryEl.classList.add('visible');
            cardsContainer.scrollTop = cardsContainer.scrollHeight;
          });
        });
      });
    }
    if (changes.pendingEntities && changes.pendingEntities.newValue) {
      isActiveTab((active) => {
        if (!active) {
          console.log('[CONTENT] Not the captured tab, ignoring entities');
          return;
        }
        console.log('[CONTENT] storage.onChanged: pendingEntities updated with', changes.pendingEntities.newValue.length, 'entities');
        renderCards(changes.pendingEntities.newValue);
      });
    }
  });

  // Check for pending entities on load
  chrome.storage.local.get(['pendingEntities', 'sessionStart', 'activeTabUrl'], (data) => {
    try {
      const activeUrl = data.activeTabUrl || '';
      const active = new URL(activeUrl);
      const current = new URL(window.location.href);
      if (active.origin + active.pathname !== current.origin + current.pathname) {
        console.log('[CONTENT] Not the captured tab on load, skipping');
        return;
      }
    } catch (e) {
      if (data.activeTabUrl && data.activeTabUrl !== window.location.href) return;
    }
    if (data.sessionStart) {
      trackSessionStart(data.sessionStart);
    }
    console.log('[CONTENT] Initial check:', data.pendingEntities ? data.pendingEntities.length + ' entities' : 'none');
    if (data.pendingEntities) {
      renderCards(data.pendingEntities);
    }
  });

  // Polling fallback: check every 2s in case storage.onChanged doesn't fire
  const pollId = setInterval(() => {
    try {
      if (!chrome.runtime?.id) {
        console.log('[CONTENT] Extension context invalidated, stopping poll');
        clearInterval(pollId);
        return;
      }
      isActiveTab((active) => {
        if (!active) return;
        chrome.storage.local.get(['pendingEntities'], (data) => {
          if (chrome.runtime.lastError) return;
          if (data.pendingEntities && data.pendingEntities.length > 0) {
            console.log('[CONTENT] Polling fallback found', data.pendingEntities.length, 'entities');
            renderCards(data.pendingEntities);
          }
        });
      });
    } catch (e) {
      console.log('[CONTENT] Extension context gone, clearing interval');
      clearInterval(pollId);
    }
  }, 2000);

  // --- Media detection: show badge on pages with video/audio ---
  const isYouTube = window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch';
  let mediaDetected = false;
  let mediaDebounce = null;

  function isLongMedia(el) {
    return el.duration && el.duration > 60;
  }

  function handleMediaPlay(el) {
    if (!chrome.runtime?.id) return;
    if (!isLongMedia(el)) return;

    if (!mediaDetected) {
      if (mediaDebounce) clearTimeout(mediaDebounce);
      mediaDebounce = setTimeout(() => {
        mediaDebounce = null;
        if (el.paused || el.ended || !isLongMedia(el)) return;
        if (mediaDetected) return;
        mediaDetected = true;
        console.log('[CONTENT] Media detected, showing badge');
        ensureBadge();
      }, 2000);
    }
  }

  function attachMediaListeners(el) {
    if (el.dataset.ctxAttached) return;
    el.dataset.ctxAttached = 'true';
    const tag = el.tagName.toLowerCase();
    console.log('[CONTENT] Attaching listeners to', tag, 'element');

    el.addEventListener('play', () => handleMediaPlay(el));

    // YouTube-specific: seek detection
    if (isYouTube) {
      el.addEventListener('seeked', () => {
        if (!chrome.runtime?.id) return;
        chrome.storage.local.get('capturing', (data) => {
          if (!data.capturing) return;
          console.log('[CONTENT] Media seeked, clearing buffer');
          try { chrome.runtime.sendMessage({ type: 'SEEK_DETECTED' }); } catch (e) {}
        });
      });
    }

    // If already playing when we attach
    if (!el.paused && !el.ended) {
      handleMediaPlay(el);
    }
  }

  // Attach to existing media elements
  document.querySelectorAll('video, audio').forEach(el => attachMediaListeners(el));

  // Observe for dynamically added media elements
  const mediaObserver = new MutationObserver(() => {
    document.querySelectorAll('video, audio').forEach(el => attachMediaListeners(el));
  });
  mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
}
