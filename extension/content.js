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
    let result = idx === -1 ? str : str.slice(0, idx + 1);
    if (result.length > 120) result = result.slice(0, 117) + '...';
    return result;
  }

  const SHADOW_CSS = `
    :host {
      display: block;
      background: #12121c;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    #sidebar {
      width: 100%; height: 100%; background: #12121c;
      display: flex; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0f0;
    }
    #header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 12px 12px 16px; background: #12121c;
      border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
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
      position: absolute; top: -24px; left: 50%; transform: translateX(-50%);
      background: #00e676; color: #0a0a12; font-size: 9px; font-weight: 600;
      padding: 2px 6px; border-radius: 4px; white-space: nowrap;
      pointer-events: none; opacity: 0; transition: opacity 0.2s;
    }
    .ctx-export-tooltip.visible { opacity: 1; }
    @keyframes ctx-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 4px #00e676; }
      50% { opacity: 0.4; box-shadow: 0 0 8px #00e676; }
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
      animation: ctx-pulse 2s ease-in-out infinite;
    }
    #listening-indicator .li-text { font-size: 10px; color: #5a5a7a; }
    #cards {
      flex: 1; overflow-y: auto; padding: 0; background: #12121c; display: none;
    }
    #cards::-webkit-scrollbar { width: 3px; }
    #cards::-webkit-scrollbar-track { background: transparent; }
    #cards::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
    .session-divider {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; background: #12121c;
    }
    .session-divider hr { flex: 1; border: none; border-top: 1px solid rgba(255,255,255,0.04); margin: 0; }
    .session-divider span { color: #5a5a7a; font-size: 10px; white-space: nowrap; }
    .context-card {
      position: relative; padding: 8px 16px 8px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.03); border-left: 2px solid #4a4a6a;
      background: #181828; animation: ctx-card-in 0.25s ease-out both;
      cursor: pointer; user-select: none;
    }
    .context-card:hover { background: #1e1e32; }
    @keyframes ctx-card-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .context-card.collapsed { animation: none; cursor: default; }
    .card-row {
      display: flex; align-items: center; gap: 8px;
    }
    .card-type {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; flex-shrink: 0;
    }
    .card-term {
      font-size: 13px; font-weight: 600; color: #e8e8f8;
      flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
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
    .card-desc { font-size: 11px; color: #9a9ab0; line-height: 1.55; }
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
    .stock-ticker { font-size: 18px; font-weight: 700; color: #e0e0f0; margin-bottom: 1px; }
    .stock-company { font-size: 10px; color: #3a3a5a; margin-bottom: 8px; }
    .stock-price-row { display: flex; align-items: baseline; gap: 8px; }
    .stock-price { font-size: 16px; font-weight: 600; color: #e0e0f0; }
    .stock-change { font-size: 12px; font-weight: 600; }
    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }
    .card-actions {
      position: absolute; top: 8px; right: 10px; display: flex; gap: 4px;
      opacity: 0; transition: opacity 0.15s; pointer-events: none;
    }
    .context-card.expanded:hover .card-actions { opacity: 1; pointer-events: auto; }
    .thumbs-up-btn, .thumbs-down-btn {
      background: none; border: none; color: #2a2a3a; font-size: 10px;
      cursor: pointer; padding: 2px 4px; border-radius: 3px; line-height: 1;
      transition: color 0.15s;
    }
    .thumbs-up-btn:hover { color: #00e676; }
    .thumbs-down-btn:hover { color: #ff5252; }
    .thumbs-up-ok { color: #00e676; font-size: 9px; padding: 2px 4px; line-height: 1; }
    .card-wiki-link {
      font-size: 10px; color: #3a3a5a; text-decoration: none;
      transition: color 0.15s; display: inline-block; margin-top: 4px;
    }
    .card-wiki-link:hover { color: #7a7aaa; }
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
      flex-shrink: 0; padding: 10px 12px; background: #0a0a12;
      border-top: 1px solid rgba(255,255,255,0.04);
    }
    .ctx-ask-input {
      width: 100%; height: 32px; background: #1a1a28;
      border: 1px solid rgba(255,255,255,0.06); border-radius: 8px;
      padding: 0 10px; font-size: 11px; color: #e0e0f0;
      font-family: inherit; outline: none;
      transition: border-color 0.2s;
    }
    .ctx-ask-input::placeholder { color: #3a3a5a; }
    .ctx-ask-input:focus { border-color: rgba(90,90,255,0.4); }
    .ctx-ask-response {
      display: none; padding: 10px 12px; font-size: 11px; color: #8a8aaa;
      line-height: 1.5; max-height: 150px; overflow-y: auto; background: #0a0a12;
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
    .light-theme #cards { background: #f5f5f8; }
    .light-theme #cards::-webkit-scrollbar-thumb { background: #d0d0e0; }
    .light-theme #listening-indicator { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme #listening-indicator .li-dot { background: #9a9ab0; }
    .light-theme #listening-indicator .li-text { color: #9a9ab0; }
    .light-theme #missed-bar { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme .session-divider { background: #f5f5f8; }
    .light-theme .session-divider hr { border-top-color: rgba(0,0,0,0.06); }
    .light-theme .session-divider span { color: #7a7a9a; }
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
    .light-theme .card-source { color: #b0b0c0; }
    .light-theme .card-popularity { color: #b0b0c0; }
    .light-theme .stock-ticker { color: #1a1a2e; }
    .light-theme .stock-company { color: #8a8aa0; }
    .light-theme .stock-price { color: #1a1a2e; }
    .light-theme .card-actions { }
    .light-theme .thumbs-up-btn, .light-theme .thumbs-down-btn { color: #b0b0c0; }
    .light-theme .card-wiki-link { color: #8a8aa0; }
    .light-theme .card-wiki-link:hover { color: #5a5a70; }
    .light-theme .feedback-msg { color: #9a9ab0; }
    .light-theme .ctx-preview-card { background: #f0f0fa; }
    .light-theme .ctx-preview-title { color: #5a5adf; }
    .light-theme .ctx-preview-term { color: #8a8aa0; }
    .light-theme .ctx-ask-bar { background: #f0f0f5; border-top-color: rgba(0,0,0,0.06); }
    .light-theme .ctx-ask-input { background: #ffffff; border-color: rgba(0,0,0,0.1); color: #1a1a2e; }
    .light-theme .ctx-ask-input::placeholder { color: #b0b0c0; }
    .light-theme .ctx-ask-input:focus { border-color: rgba(90,90,255,0.4); }
    .light-theme .ctx-ask-response { background: #f0f0f5; border-top-color: rgba(0,0,0,0.06); color: #5a5a7a; }
    .light-theme .ctx-ask-response::-webkit-scrollbar-thumb { background: #d0d0e0; }
    .light-theme .ctx-ask-clear { color: #b0b0c0; }
    .light-theme .ctx-ask-clear:hover { color: #5a5a70; }
  `;

  const BADGE_CSS = `
    :host { display: block; }
    .ctx-badge {
      width: 36px; height: 36px; border-radius: 50%;
      background: #1a1a2e; border: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: box-shadow 0.3s ease, border-color 0.2s;
      user-select: none;
    }
    .ctx-badge:hover {
      border-color: rgba(255,255,255,0.15);
      background: #1e1e32;
    }
    .ctx-badge.pulse {
      animation: badge-glow 1.5s ease-out;
    }
    @keyframes badge-glow {
      0% { box-shadow: 0 0 12px rgba(0,230,118,0.4); }
      100% { box-shadow: none; }
    }
    .ctx-badge-count {
      font-size: 13px; font-weight: 600; color: #e0e0f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1;
    }
    .ctx-toast {
      position: fixed; bottom: 65px; right: 20px;
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
    /* Light theme */
    .ctx-badge.light { background: #ffffff; border-color: rgba(0,0,0,0.08); }
    .ctx-badge.light:hover { background: #f5f5f8; border-color: rgba(0,0,0,0.12); }
    .ctx-badge.light .ctx-badge-count { color: #1a1a2e; }
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
    badge.innerHTML = '<span class="ctx-badge-count">0</span>';
    badge.addEventListener('click', () => {
      if (!hostEl) return;
      if (hostEl.dataset.open === 'true') {
        closeSidebar();
      } else {
        openSidebar();
        resetAutoHide();
      }
    });
    badgeShadow.appendChild(badge);
    document.body.appendChild(badgeEl);
  }

  function updateBadge(newCards) {
    if (!badgeShadow) return;
    const countEl = badgeShadow.querySelector('.ctx-badge-count');
    if (countEl) countEl.textContent = termCount;

    if (newCards > 0) {
      const badge = badgeShadow.querySelector('.ctx-badge');
      if (badge) {
        badge.classList.remove('pulse');
        void badge.offsetWidth;
        badge.classList.add('pulse');
      }
    }
  }

  let toastTimer = null;

  function showToast(entity) {
    if (!badgeShadow) return;
    // Don't show if sidebar is open
    if (hostEl && hostEl.dataset.open === 'true') return;

    // Remove existing toast
    const existing = badgeShadow.querySelector('.ctx-toast');
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
      openSidebar();
      resetAutoHide();
    });
    badgeShadow.appendChild(toast);

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
    const bg = isLightTheme ? '#f5f5f8' : '#0e0e16';
    const translate = pos === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    return `position:fixed;top:0;${pos}:0;width:280px;height:100vh;z-index:2147483647;${border}background:${bg};transform:${translate};transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);`;
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
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const upBtn = document.createElement('button');
    upBtn.className = 'thumbs-up-btn';
    upBtn.innerHTML = '&#x1F44D;';
    upBtn.title = 'Useful';
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.storage.local.get('likedEntities', (data) => {
        const liked = data.likedEntities || [];
        liked.push({ type: entity.type || 'other', term: key, timestamp: Date.now() });
        chrome.storage.local.set({ likedEntities: liked });
      });
      upBtn.innerHTML = '&#x2713;';
      upBtn.classList.add('thumbs-up-ok');
      setTimeout(() => {
        upBtn.innerHTML = '&#x1F44D;';
        upBtn.classList.remove('thumbs-up-ok');
      }, 1000);
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'thumbs-down-btn';
    downBtn.innerHTML = '&#x1F44E;';
    downBtn.title = 'Not useful';
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      ignoreList.add(key);
      chrome.storage.local.set({ ignoreList: Array.from(ignoreList) });
      card.innerHTML = '<div class="feedback-msg">Thanks for the feedback</div>';
      card.classList.add('collapsed');
      card.style.borderLeftColor = '#4a4a6a';
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    card.appendChild(actions);
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

    let descFetched = false;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a')) return;
      card.classList.toggle('expanded');

      if (card.classList.contains('expanded') && !descFetched) {
        descFetched = true;
        const descEl = card.querySelector('.card-desc');
        descEl.classList.add('card-desc-loading');

        chrome.storage.local.get('userProfile', (data) => {
          try { if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'CONTEXT_FETCH' }); } catch (e) {}
          fetch('https://context-extension-zv8d.vercel.app/api/context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              term: entity.term || entity.name || '',
              userProfile: data.userProfile || null
            })
          })
          .then(res => res.ok ? res.json() : Promise.reject(res))
          .then(contextData => {
            descEl.classList.remove('card-desc-loading');
            const desc = firstSentence(contextData.description || '');
            descEl.textContent = desc;
            // Update sessionHistory with description
            const termName = entity.term || entity.name || '';
            chrome.storage.local.get('sessionHistory', (hData) => {
              const history = hData.sessionHistory || [];
              const entry = history.find(h => h.term === termName && !h.description);
              if (entry) {
                entry.description = desc;
                chrome.storage.local.set({ sessionHistory: history });
              }
            });
            // Track popularity
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
          })
          .catch(() => {
            descEl.classList.remove('card-desc-loading');
            descEl.textContent = 'Could not load description';
          });
        });
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

    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && askInput.value.trim()) {
        const question = askInput.value.trim();
        askInput.value = '';

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

    sidebar.appendChild(header);
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

  function renderSessionDivider(timestamp) {
    if (timestamp === lastSessionStart) return;
    lastSessionStart = timestamp;

    ensureSidebar();
    const cards = shadowRoot.getElementById('cards');
    const timeStr = formatTime(new Date(timestamp));

    const divider = document.createElement('div');
    divider.className = 'session-divider';
    divider.innerHTML =
      '<hr>' +
      '<span>Session started ' + timeStr + '</span>' +
      '<hr>';

    cards.prepend(divider);
    showCardsHideEmpty();
    console.log('[CONTENT] Session divider added:', timeStr);
  }

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards:', entities.length, 'entities');

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

    // Split into highlights (shown in sidebar) and background (recap only)
    const highlights = entities.filter(e => e.salience !== 'background');
    const background = entities.filter(e => e.salience === 'background');

    // Store background entities in sessionHistory only
    if (background.length > 0) {
      chrome.storage.local.get('sessionHistory', (hData) => {
        const history = hData.sessionHistory || [];
        background.forEach(e => {
          const term = e.term || e.name || '';
          if (term) history.push({ term, type: e.type || 'other', timestamp: Date.now(), description: '', salience: 'background' });
        });
        chrome.storage.local.set({ sessionHistory: history });
      });
      termCount += background.length;
      console.log('[CONTENT] Stored', background.length, 'background entities for recap');
    }

    if (highlights.length > 0) {
      showCardsHideEmpty();

      // Hide listening indicator and reset timer
      if (shadowRoot) {
        const li = shadowRoot.getElementById('listening-indicator');
        if (li) li.classList.remove('visible');
      }
      if (listeningTimer) clearTimeout(listeningTimer);
      listeningTimer = setTimeout(() => {
        if (shadowRoot && hasCards) {
          const li = shadowRoot.getElementById('listening-indicator');
          if (li) li.classList.add('visible');
        }
      }, 20000);

      const limited = highlights.slice(0, settings.cardsPerChunk);
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

      // Show toast for first highlight if sidebar is closed
      if (hostEl && hostEl.dataset.open !== 'true' && limited.length > 0) {
        showToast(limited[0]);
      }
    } else {
      // Still update badge count for background entities but don't pulse
      updateBadge(0);
    }

    chrome.storage.local.remove('pendingEntities');
  }

  // Listen for future updates
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sessionStart && changes.sessionStart.newValue) {
      isActiveTab((active) => {
        if (active) renderSessionDivider(changes.sessionStart.newValue);
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
      renderSessionDivider(data.sessionStart);
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

  // --- Auto-capture: detect playing media on any site ---
  const isYouTube = window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch';
  let autoCapturing = false;
  let autoPaused = false;
  let autoStartDebounce = null;

  function isLongMedia(el) {
    return el.duration && el.duration > 60;
  }

  function anyMediaPlaying() {
    const els = document.querySelectorAll('video, audio');
    for (const el of els) {
      if (!el.paused && !el.ended && el.dataset.ctxAttached && isLongMedia(el)) return true;
    }
    return false;
  }

  function handleMediaPlay(el) {
    if (!chrome.runtime?.id) return;
    if (!isLongMedia(el)) {
      console.log('[CONTENT] Ignoring short media element, duration:', el.duration);
      return;
    }

    if (!autoCapturing) {
      // Debounce to avoid ads
      if (autoStartDebounce) clearTimeout(autoStartDebounce);
      autoStartDebounce = setTimeout(() => {
        autoStartDebounce = null;
        // Re-check the element is still playing and long enough
        if (el.paused || el.ended || !isLongMedia(el)) return;
        if (autoCapturing) return;
        autoCapturing = true;
        autoPaused = false;
        console.log('[CONTENT] Media playing, auto-starting capture');
        try { chrome.runtime.sendMessage({ type: 'START_CAPTURE' }); } catch (e) {}
        chrome.storage.local.set({ capturing: true });
      }, 2000);
    } else if (autoPaused) {
      autoPaused = false;
      console.log('[CONTENT] Media resumed');
      try { chrome.runtime.sendMessage({ type: 'RESUME_CAPTURE' }); } catch (e) {}
    }
  }

  function handleMediaPause() {
    if (!autoCapturing || autoPaused) return;
    if (!chrome.runtime?.id) return;
    // Check if any other tracked media is still playing
    if (anyMediaPlaying()) return;
    autoPaused = true;
    console.log('[CONTENT] All media paused');
    try { chrome.runtime.sendMessage({ type: 'PAUSE_CAPTURE' }); } catch (e) {}
  }

  function handleMediaEnded() {
    if (!chrome.runtime?.id) return;
    // Check if any other tracked media is still playing
    if (anyMediaPlaying()) return;
    if (!autoCapturing) return;
    autoCapturing = false;
    autoPaused = false;
    console.log('[CONTENT] All media ended, stopping capture');
    try { chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }); } catch (e) {}
    chrome.storage.local.set({ capturing: false });
  }

  function attachMediaListeners(el) {
    if (el.dataset.ctxAttached) return;
    el.dataset.ctxAttached = 'true';
    const tag = el.tagName.toLowerCase();
    console.log('[CONTENT] Attaching listeners to', tag, 'element');

    el.addEventListener('play', () => handleMediaPlay(el));
    el.addEventListener('pause', () => handleMediaPause());
    el.addEventListener('ended', () => handleMediaEnded());

    // YouTube-specific: seek detection
    if (isYouTube) {
      el.addEventListener('seeked', () => {
        if (!autoCapturing) return;
        if (!chrome.runtime?.id) return;
        console.log('[CONTENT] Media seeked, clearing buffer');
        try { chrome.runtime.sendMessage({ type: 'SEEK_DETECTED' }); } catch (e) {}
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
