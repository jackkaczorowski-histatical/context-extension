console.log('[CONTENT] Script loaded');

// Reset the guard if the sidebar was lost (extension reload, context invalidation, etc.)
if (window.__contextExtensionLoaded && !document.getElementById('context-sidebar-host')) {
  console.log('[CONTENT] Sidebar lost, resetting guard for reinitialization');
  window.__contextExtensionLoaded = false;
}

if (!window.__contextExtensionLoaded) {
  window.__contextExtensionLoaded = true;
  let isLightTheme = false;

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise((resolve, reject) => {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

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
  let mySessionId = null;
  let currentlyExpandedCard = null;
  const isYouTubeSite = window.location.hostname.includes('youtube.com');

  const TYPE_COLORS = {
    event: '#6366f1',
    concept: '#6366f1',
    person: '#6366f1',
    people: '#6366f1',
    stock: '#00e676',
    organization: '#6366f1',
    commodity: '#6366f1',
    ingredient: '#6366f1'
  };

  function toggleCardExpand(card) {
    if (card.classList.contains('expanded')) {
      card.classList.remove('expanded');
      if (currentlyExpandedCard === card) currentlyExpandedCard = null;
    } else {
      if (currentlyExpandedCard && currentlyExpandedCard !== card) {
        currentlyExpandedCard.classList.remove('expanded');
      }
      card.classList.add('expanded');
      currentlyExpandedCard = card;
    }
  }

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

  function formatVideoTime() {
    const elapsed = lastSessionStart ? Date.now() - lastSessionStart : 0;
    const totalSec = Math.floor(elapsed / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = String(totalSec % 60).padStart(2, '0');
    return { display: `${mins}:${secs}`, seconds: totalSec };
  }

  function seekVideo(seconds) {
    try {
      // Spotify blocks programmatic seek
      if (window.location.hostname.includes('spotify.com')) return;
      const video = document.querySelector('video');
      if (video) { video.currentTime = seconds; }
    } catch (e) {
      console.log('[CONTENT] Seek failed:', e.message);
    }
  }

  function truncateHeadline(text, maxChars = 80) {
    if (!text || text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 60 ? truncated.slice(0, lastSpace) : truncated) + '\u2026';
  }

  let activeTooltip = null;
  function showCardTooltip(card, fullText) {
    hideCardTooltip();
    const tip = document.createElement('div');
    tip.className = 'ctx-card-tooltip';
    tip.textContent = fullText;
    card.style.position = card.style.position || 'relative';
    card.appendChild(tip);
    activeTooltip = tip;
  }
  function hideCardTooltip() {
    if (activeTooltip && activeTooltip.parentNode) {
      activeTooltip.parentNode.removeChild(activeTooltip);
    }
    activeTooltip = null;
  }
  function attachTruncationTooltip(card, fullText, displayedText) {
    if (!fullText || fullText.length <= (displayedText || '').length) return;
    card.addEventListener('mouseenter', () => showCardTooltip(card, fullText));
    card.addEventListener('mouseleave', hideCardTooltip);
  }

  function generateCardPNG(entity) {
    const term = entity.term || entity.name || '';
    const type = (entity.type || 'other').toUpperCase();
    const desc = entity.description || entity.detail || '';
    const color = getTypeColor(entity.type);
    const videoTitle = document.title || '';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const w = 600;

    // Measure text to determine height
    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    const headlineLines = wrapText(ctx, term, w - 60);
    ctx.font = '14px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    const descLines = desc ? wrapText(ctx, desc, w - 60) : [];
    const h = Math.max(200, 40 + headlineLines.length * 32 + (descLines.length > 0 ? descLines.length * 20 + 16 : 0) + 50);

    canvas.width = w;
    canvas.height = h;

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    // Type label
    ctx.fillStyle = color;
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillText(type, 30, 35);

    // Headline
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    let y = 65;
    headlineLines.forEach(line => { ctx.fillText(line, 30, y); y += 32; });

    // Description
    if (descLines.length > 0) {
      y += 8;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '14px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
      descLines.forEach(line => { ctx.fillText(line, 30, y); y += 20; });
    }

    // Footer
    ctx.fillStyle = '#475569';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    const footer = 'via Context Listener' + (videoTitle ? '  \u00B7  ' + videoTitle.slice(0, 50) : '');
    ctx.fillText(footer, 30, h - 20);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `context-${term.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
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
      isolation: isolate;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    *:focus { outline: none; }
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
      overflow: visible;
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
    .ctx-clear-btn {
      background: none; border: 1px solid rgba(255,255,255,0.08); color: #64748b; font-size: 11px;
      cursor: pointer; padding: 3px 8px; border-radius: 4px;
      line-height: 1; transition: color 0.15s, background 0.15s; font-family: inherit;
    }
    .ctx-clear-btn:hover { color: #ef4444; background: rgba(239,68,68,0.08); }
    .ctx-clear-confirm { font-size: 11px; color: #ef4444; display: inline-flex; align-items: center; gap: 6px; }
    .ctx-clear-confirm-link {
      background: none; border: none; font-size: 11px; cursor: pointer;
      font-family: inherit; padding: 0; text-decoration: underline;
    }
    .ctx-clear-confirm-link.yes { color: #ef4444; }
    .ctx-clear-confirm-link.no { color: #64748b; }
    .ctx-export-tooltip {
      position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
      background: #00e676; color: #0a0a12; font-size: 9px; font-weight: 600;
      padding: 2px 6px; border-radius: 4px; white-space: nowrap;
      pointer-events: none; opacity: 0; transition: opacity 0.2s;
    }
    .ctx-export-tooltip.visible { opacity: 1; }
    .ctx-export-menu {
      display: none; position: absolute; top: 100%; right: 0;
      background: #1e293b; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; padding: 4px 0; z-index: 50;
      min-width: 170px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    .ctx-export-menu.visible { display: block; }
    .ctx-export-menu-item {
      display: block; width: 100%; padding: 8px 14px; font-size: 12px;
      color: #e2e8f0; background: none; border: none; text-align: left;
      cursor: pointer; font-family: inherit; white-space: nowrap;
      transition: background 0.15s;
    }
    .ctx-export-menu-item:hover { background: rgba(255,255,255,0.05); }
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
      font-size: 13px; color: #e2e8f0; line-height: 20px; max-width: 100%;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      padding: 6px 10px; flex-shrink: 0; display: none; font-style: italic;
      background: rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,255,255,0.08);
      -webkit-mask-image: linear-gradient(to right, black 70%, transparent 100%);
      mask-image: linear-gradient(to right, black 70%, transparent 100%);
      transition: background 0.5s ease, opacity 0.3s ease;
    }
    #transcript-strip.visible { display: block; }
    #transcript-strip.flash { background: rgba(99,102,241,0.15); }
    #transcript-strip.paused { opacity: 0.4; }
    .ctx-silence-indicator { color: #64748b; font-style: normal; margin-left: 6px; }
    #cards {
      flex: 1; overflow-y: auto; padding: 0; background: #12121c; display: none;
      position: relative; z-index: 1;
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
    .context-card.quick-known { opacity: 0.35; transition: opacity 0.3s ease; }
    .context-card.quick-known:hover { opacity: 0.6; }
    .card-quick-dismiss {
      position: absolute; top: 8px; right: 8px; width: 20px; height: 20px;
      border-radius: 50%; border: 1px solid rgba(255,255,255,0.15); background: none;
      color: rgba(255,255,255,0.3); font-size: 10px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.2s; padding: 0; line-height: 1;
    }
    .card-quick-dismiss:hover { border-color: rgba(0,230,118,0.5); color: #00e676; background: rgba(0,230,118,0.1); }
    .context-card.quick-known .card-quick-dismiss { border-color: rgba(0,230,118,0.4); color: #00e676; }
    .card-row {
      display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
    }
    .card-type {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; flex-shrink: 0;
      word-wrap: break-word; overflow-wrap: break-word; max-width: 100%;
      width: 100%;
    }
    .card-term {
      font-size: 13px; font-weight: 600; color: #e8e8f8;
      flex: 1; min-width: 0;
      white-space: normal; word-break: normal; overflow-wrap: normal;
    }
    .card-time { font-size: 11px; color: #64748b; flex-shrink: 0; cursor: pointer; text-decoration: none; }
    .card-time:hover { text-decoration: underline; }
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
    .card-source { font-size: 11px; color: #94a3b8; margin-top: 4px; font-style: italic; }
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
    .card-tellmore {
      font-size: 10px; color: #6366f1; background: rgba(99,102,241,0.1);
      border: none; border-radius: 10px; padding: 3px 10px; cursor: pointer;
      margin-top: 4px; margin-left: 6px; font-family: inherit;
      display: inline-block; transition: background 0.15s;
    }
    .card-tellmore:hover { background: rgba(99,102,241,0.2); }
    .card-copy-btn {
      background: rgba(99,102,241,0.1); color: #6366f1; border: none;
      border-radius: 10px; padding: 3px 10px; cursor: pointer;
      margin-top: 4px; font-size: 10px; font-family: inherit;
      display: inline-block; transition: background 0.15s, color 0.15s;
    }
    .card-copy-btn:hover { background: rgba(99,102,241,0.2); }
    .card-copy-btn.copied { color: #00e676; background: rgba(0,230,118,0.1); }
    .card-share-btn {
      position: absolute; top: 8px; right: 12px; background: none; border: none;
      color: #64748b; font-size: 14px; cursor: pointer; padding: 2px 4px;
      line-height: 1; transition: color 0.15s; display: none; z-index: 2;
    }
    .card-share-btn:hover { color: #f8fafc; }
    .context-card.expanded .card-share-btn { display: block; }
    .card-preview-text { font-size: 11px; color: #64748b; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .context-card.expanded .card-preview-text { display: none; }
    .ctx-card-tooltip {
      position: absolute; background: #1e293b; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #e2e8f0;
      max-width: 240px; z-index: 9999; pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); line-height: 1.4; word-wrap: break-word;
    }
    .context-card.salience-background { opacity: 0.65; border-left-color: transparent !important; }
    .context-card.salience-background .card-term { font-size: 12px; }
    .context-card.salience-background .card-type { font-size: 10px; }
    .context-card.insight-card { border-left-color: #f59e0b; background: rgba(245,158,11,0.04); }
    .context-card.insight-card:hover { background: rgba(245,158,11,0.08); }
    .insight-icon { font-size: 11px; margin-right: 4px; }
    .insight-category {
      font-size: 9px; font-weight: 600; letter-spacing: 0.1em;
      text-transform: uppercase; color: #f59e0b;
    }
    .insight-text { font-size: 12px; color: #e0e0f0; font-weight: 500; line-height: 1.4; margin-top: 2px; }
    .insight-detail { font-size: 11px; color: #9a9ab0; line-height: 1.5; margin-top: 4px; }
    .ctx-quiz-pill {
      display: inline-block; background: rgba(99,102,241,0.12); color: #6366f1;
      border: none; border-radius: 12px; padding: 4px 12px; font-size: 11px;
      cursor: pointer; font-family: inherit; margin-top: 6px; transition: background 0.15s;
    }
    .ctx-quiz-pill:hover { background: rgba(99,102,241,0.22); }
    .ctx-quiz-inline { margin-top: 8px; }
    .ctx-quiz-inline-q { font-size: 12px; color: #e0e0f0; font-weight: 500; margin-bottom: 6px; }
    .ctx-quiz-inline-opt {
      display: block; width: 100%; text-align: left; background: #1e1e38;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
      padding: 6px 10px; margin-bottom: 4px; font-size: 11px; color: #e0e0f0;
      cursor: pointer; font-family: inherit; transition: border-color 0.2s;
    }
    .ctx-quiz-inline-opt:hover { border-color: rgba(99,102,241,0.4); }
    .ctx-quiz-inline-opt.correct { border-color: #00e676; background: rgba(0,230,118,0.1); }
    .ctx-quiz-inline-opt.wrong { border-color: #ff5252; background: rgba(255,82,82,0.1); }
    .ctx-quiz-check { color: #00e676; font-size: 12px; margin-left: 4px; }
    .ctx-quiz-btn {
      background: rgba(99,102,241,0.15); color: #6366f1; border: none;
      border-radius: 12px; padding: 8px 16px; font-size: 12px; cursor: pointer;
      margin-top: 8px; font-family: inherit; display: inline-block; transition: background 0.15s;
    }
    .ctx-quiz-btn:hover { background: rgba(99,102,241,0.25); }
    .ctx-quiz-overlay {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: #12121c; z-index: 100; display: flex; flex-direction: column;
      padding: 20px 16px; overflow-y: auto;
    }
    .ctx-quiz-question {
      font-size: 14px; color: #e0e0f0; font-weight: 600; margin-bottom: 16px; line-height: 1.4;
    }
    .ctx-quiz-option {
      display: block; width: 100%; text-align: left; background: #1e1e38;
      border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
      padding: 10px 14px; margin-bottom: 8px; font-size: 12px; color: #e0e0f0;
      cursor: pointer; font-family: inherit; transition: border-color 0.2s, background 0.2s;
    }
    .ctx-quiz-option:hover { border-color: rgba(99,102,241,0.4); background: #24244a; }
    .ctx-quiz-option.correct { border-color: #00e676; background: rgba(0,230,118,0.1); }
    .ctx-quiz-option.wrong { border-color: #ff5252; background: rgba(255,82,82,0.1); }
    .ctx-quiz-next {
      background: rgba(99,102,241,0.15); color: #6366f1; border: none;
      border-radius: 8px; padding: 8px 16px; font-size: 12px; cursor: pointer;
      margin-top: 12px; font-family: inherit;
    }
    .ctx-quiz-score {
      font-size: 18px; font-weight: 700; color: #6366f1; text-align: center; margin: 20px 0;
    }
    .ctx-quiz-close {
      background: none; border: none; color: #3a3a5a; font-size: 14px;
      cursor: pointer; position: absolute; top: 12px; right: 12px;
    }
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

    /* ─── KB matches ─── */
    #empty-kb-matches {
      max-height: 150px;
      overflow-y: auto;
      transition: max-height 0.3s ease, opacity 0.3s ease;
    }
    #empty-kb-matches.collapsed {
      max-height: 0;
      overflow: hidden;
      opacity: 0;
      margin: 0 !important;
      padding: 0 !important;
    }
    .kb-matches-toggle {
      font-size: 10px;
      color: #6a6a8a;
      cursor: pointer;
      user-select: none;
      padding: 4px 0;
      display: none;
    }
    .kb-matches-toggle:hover { color: #9a9ab0; }
    .kb-matches-toggle.visible { display: block; }

    /* ─── Preview card ─── */
    .ctx-preview-card {
      display: none; padding: 10px 16px; background: #12121f;
      border-left: 2px solid #5a5aff; border-bottom: 1px solid rgba(255,255,255,0.03);
      flex-shrink: 0; transition: opacity 0.2s ease;
    }
    .ctx-preview-card.visible { display: block; }
    .ctx-preview-title {
      font-size: 10px; font-weight: 600; color: #7070ff;
      margin-bottom: 6px; cursor: pointer; user-select: none;
    }
    .ctx-preview-title:hover { color: #9090ff; }
    .ctx-preview-title::after { content: ' \u25B4'; font-size: 8px; }
    .ctx-preview-card.collapsed .ctx-preview-title::after { content: ' \u25BE'; }
    .ctx-preview-items {
      max-height: 120px; overflow-y: auto; transition: max-height 0.2s ease;
    }
    .ctx-preview-card.collapsed .ctx-preview-items { max-height: 0; overflow: hidden; }
    .ctx-preview-term {
      font-size: 10px; color: #5a5a7a; line-height: 1.6;
    }

    /* ─── Tab bar (hidden — single view) ─── */
    .ctx-tab-bar { display: none; }
    /* ─── Suggested questions ─── */
    .ctx-suggestions { display: none; padding: 6px 12px; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
    .ctx-suggestions.visible { display: flex; }
    .ctx-suggestion-pill {
      background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3);
      color: #a5b4fc; font-size: 11px; padding: 4px 10px; border-radius: 12px;
      cursor: pointer; font-family: inherit; transition: opacity 0.3s ease, background 0.15s;
    }
    .ctx-suggestion-pill:hover { background: rgba(99,102,241,0.25); }
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
      display: none; padding: 10px 12px; font-size: 13px; color: #e2e8f0;
      line-height: 1.5; max-height: 200px; overflow-y: auto;
      background: rgba(255,255,255,0.05);
      border-top: 1px solid rgba(255,255,255,0.08); position: relative;
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
    .light-theme .ctx-clear-btn { color: #9a9ab0; }
    .light-theme .ctx-clear-btn:hover { color: #ff5252; background: rgba(255,82,82,0.06); }
    .light-theme #empty-state { background: #f5f5f8; }
    .light-theme .ctx-waveform span { background: #c0c0d0; }
    .light-theme .ctx-empty-text { color: #7a7a9a; }
    .light-theme #transcript-strip { color: #475569; background: rgba(0,0,0,0.03); border-bottom-color: rgba(0,0,0,0.06); }
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
    .light-theme .card-tellmore { background: rgba(99,102,241,0.08); }
    .light-theme .card-copy-btn { background: rgba(99,102,241,0.08); color: #6366f1; }
    .light-theme .card-copy-btn:hover { background: rgba(99,102,241,0.15); }
    .light-theme .card-copy-btn.copied { color: #059669; background: rgba(5,150,105,0.08); }
    .light-theme .card-quick-dismiss { border-color: rgba(0,0,0,0.15); color: rgba(0,0,0,0.3); }
    .light-theme .card-quick-dismiss:hover { border-color: rgba(5,150,105,0.5); color: #059669; background: rgba(5,150,105,0.1); }
    .light-theme .context-card.insight-card { background: rgba(245,158,11,0.05); border-left-color: #f59e0b; }
    .light-theme .context-card.insight-card:hover { background: rgba(245,158,11,0.1); }
    .light-theme .insight-text { color: #1a1a2e; }
    .light-theme .insight-detail { color: #5a5a7a; }
    .light-theme .feedback-msg { color: #9a9ab0; }
    .light-theme .kb-matches-toggle { color: #8a8aa0; }
    .light-theme .kb-matches-toggle:hover { color: #5a5a70; }
    .light-theme .ctx-preview-card { background: #f0f0fa; }
    .light-theme .ctx-preview-title { color: #5a5adf; }
    .light-theme .ctx-preview-term { color: #8a8aa0; }
    .light-theme .ctx-ask-bar { background: #f5f5fa; border-top-color: rgba(0,0,0,0.06); box-shadow: 0 -4px 12px rgba(0,0,0,0.06); }
    .light-theme .ctx-ask-input { background: #ffffff; border-color: rgba(0,0,0,0.12); color: #1a1a2e; }
    .light-theme .ctx-ask-input::placeholder { color: #9a9ab0; }
    .light-theme .ctx-ask-input:focus { border-color: rgba(90,90,255,0.4); }
    .light-theme .ctx-ask-response { background: rgba(0,0,0,0.03); border-top-color: rgba(0,0,0,0.08); color: #1a1a2e; }
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
    .ctx-notion-btn {
      background: rgba(255,255,255,0.07); color: #e0e0f0; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 6px 14px; font-size: 11px;
      cursor: pointer; margin-top: 6px; font-family: inherit; transition: background 0.15s;
    }
    .ctx-notion-btn:hover { background: rgba(255,255,255,0.12); }
    .ctx-notion-modal {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); z-index: 200; display: flex;
      align-items: center; justify-content: center; padding: 20px;
    }
    .ctx-notion-modal-inner {
      background: #1e1e38; border-radius: 12px; padding: 20px; width: 100%; max-width: 260px;
    }
    .ctx-notion-modal-title { font-size: 13px; font-weight: 600; color: #e0e0f0; margin-bottom: 12px; }
    .ctx-notion-modal-input {
      width: 100%; height: 32px; background: #12121c;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
      padding: 0 8px; font-size: 11px; color: #e0e0f0;
      font-family: inherit; outline: none; margin-bottom: 8px;
    }
    .ctx-notion-modal-input::placeholder { color: #6a6a8a; }
    .ctx-notion-modal-save {
      width: 100%; height: 32px; background: #6366f1; color: #fff; border: none;
      border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
      font-family: inherit; margin-top: 4px;
    }
    .ctx-notion-modal-cancel {
      display: block; width: 100%; text-align: center; font-size: 10px; color: #64748b;
      cursor: pointer; margin-top: 8px; background: none; border: none; font-family: inherit;
    }
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
    hostEl.style.pointerEvents = 'auto';
  }

  function closeSidebar() {
    if (!hostEl) return;
    hostEl.dataset.open = 'false';
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    hostEl.style.transform = pos === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    hostEl.style.pointerEvents = 'none';
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
        if (reaction === 'new') addToNotes(card);
        card.classList.add('reacted');
        setTimeout(() => {
          card.classList.remove('expanded');
        }, 500);
      });

      row.appendChild(group);
    });

    expandArea.appendChild(row);
  }

  const SHOP_KEYWORDS = /setup|gear|tackle|recipe|ingredients|build|diy|unboxing|what\s+i\s+use|my\s+favorite|best\s+lures|starter\s+kit/i;
  const EXCLUDE_KEYWORDS = /history|politics|war|battle|election|president|congress|military|wwi|wwii|world\s*war|how\s+it\s+works|how\s+they\s+work|explained|science|economics|what\s+is|how\s+does/i;
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

  function insightKey(text) {
    return (text || '').toLowerCase().replace(/\s+/g, '').slice(0, 40);
  }

  function createInsightCard(insight) {
    const card = document.createElement('div');
    card.className = 'context-card insight-card';
    card.dataset.insightKey = insightKey(insight.insight || '');
    card.style.borderLeftColor = '#f59e0b';
    const vt = formatVideoTime();
    const category = escapeHtml(insight.category || 'insight');
    const insightText = insight.insight || '';
    const shortInsight = truncateHeadline(insightText, 47);
    const displayHeadline = truncateHeadline(insightText);
    const detail = escapeHtml(insight.detail || '');

    card.innerHTML = `
      <button class="card-quick-dismiss" title="I know this">\u2713</button>
      <button class="card-share-btn" title="Share as image">\u2197</button>
      <div class="card-row">
        <span class="insight-category">\u{1F4A1} ${category}</span>
        <span class="card-term" style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px; display:inline-block; vertical-align:middle;">${escapeHtml(shortInsight)}</span>
        <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      <div class="card-expand-area">
        <div class="insight-text">${escapeHtml(insightText)}</div>
        ${detail ? `<div class="insight-detail">${detail}</div>` : ''}
        <button class="card-copy-btn">Copy text</button>
      </div>
    `;

    card.querySelector('.card-quick-dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.toggle('quick-known');
    });

    // Title attributes for native tooltips on truncated elements
    const termEl = card.querySelector('.card-term');
    if (termEl) termEl.setAttribute('title', insightText);
    const catEl = card.querySelector('.insight-category');
    if (catEl) catEl.setAttribute('title', insight.category || 'insight');
    if (detail) {
      const detailEl = card.querySelector('.insight-detail');
      if (detailEl) detailEl.setAttribute('title', insight.detail);
    }

    card.querySelector('.card-copy-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = insight.insight || '';
      const det = insight.detail || '';
      const copyText = text + (det ? ' \u2014 ' + det : '');
      copyToClipboard(copyText).then(() => {
        const btn = card.querySelector('.card-copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy text'; btn.classList.remove('copied'); }, 1500);
      });
    });

    card.querySelector('.card-share-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      generateCardPNG({ term: insightText, type: 'insight', description: insight.detail || '' });
    });

    card.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('.card-share-btn')) return;
      const timeEl = e.target.closest('.card-time');
      if (timeEl && timeEl.dataset.seek) { e.stopPropagation(); seekVideo(parseInt(timeEl.dataset.seek)); return; }
      toggleCardExpand(card);
    });

    return card;
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card stock-card expanded';
    const color = getTypeColor('stock');
    card.style.borderLeftColor = color;

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const vt = formatVideoTime();

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
      const stockDesc = firstSentence(entity.description || '');
      const displayStockDesc = truncateHeadline(stockDesc);
      expandContent = `
        <div class="stock-company">${companyName}</div>
        ${displayStockDesc ? `<div class="card-desc">${escapeHtml(displayStockDesc)}</div>` : ''}
      `;
    }

    card.innerHTML = `
      <button class="card-share-btn" title="Share as image">\u2197</button>
      <div class="card-row">
        <span class="card-type" style="color:${color}">STOCK</span>
        <span class="card-term">${ticker}</span>
        <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      <div class="card-expand-area">${expandContent}</div>
    `;

    // Title attributes for native tooltips
    const stockDescEl = card.querySelector('.card-desc');
    if (stockDescEl) {
      stockDescEl.setAttribute('title', entity.description || '');
    }

    card.querySelector('.card-share-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      generateCardPNG(entity);
    });

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a') || e.target.closest('.card-share-btn')) return;
      const timeEl = e.target.closest('.card-time');
      if (timeEl && timeEl.dataset.seek) { e.stopPropagation(); seekVideo(parseInt(timeEl.dataset.seek)); return; }
      toggleCardExpand(card);
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
    if (entity.salience === 'background') card.classList.add('salience-background');

    const vt = formatVideoTime();
    const typeLabel = (type || 'OTHER').toUpperCase();
    const termText = escapeHtml(capitalizeTerm(entity.term || entity.name || ''));

    const wikiTerm = (entity.term || entity.name || '').replace(/ /g, '_');
    const wikiUrl = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(wikiTerm);

    const typeBadge = isRectx
      ? `<span class="card-type" style="color:#7070ff">&#x21BB; ${typeLabel}</span><span class="card-rectx">new context</span>`
      : `<span class="card-type" style="color:${color}">${typeLabel}</span>`;
    const seenTag = !isRectx && entity._kbSeen ? '<span class="card-seen">seen before</span>' : '';

    const shortSource = entity._kbSource ? truncateHeadline(entity._kbSource, 40) : '';
    const sourceLine = isRectx && shortSource
      ? '<div class="card-source">Previously in: ' + escapeHtml(shortSource) + '</div>'
      : (shortSource ? '<div class="card-source">Also in: ' + escapeHtml(shortSource) + '</div>' : '');

    const previewDesc = entity.description ? truncateHeadline(entity.description, 60) : '';

    card.innerHTML = `
      <button class="card-quick-dismiss" title="I know this">\u2713</button>
      <button class="card-share-btn" title="Share as image">\u2197</button>
      <div class="card-row">
        ${typeBadge}
        <span class="card-term">${termText}</span>
        ${seenTag}
        <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      ${previewDesc ? `<div class="card-preview-text">${escapeHtml(previewDesc)}</div>` : ''}
      <div class="card-expand-area">
        <div class="card-desc"></div>
        ${sourceLine}
        <a class="card-wiki-link" href="${wikiUrl}" target="_blank" rel="noopener">Wikipedia \u2192</a>
        <button class="card-tellmore">Tell me more</button>
        <button class="card-copy-btn">Copy text</button>
      </div>
    `;

    card.querySelector('.card-quick-dismiss').addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.toggle('quick-known');
    });

    // Title attributes for native tooltips on truncated elements
    const fullTermText = entity.term || entity.name || '';
    const termElG = card.querySelector('.card-term');
    if (termElG) termElG.setAttribute('title', fullTermText);
    const previewEl = card.querySelector('.card-preview-text');
    if (previewEl) previewEl.setAttribute('title', entity.description || '');
    const sourceEl = card.querySelector('.card-source');
    if (sourceEl) sourceEl.setAttribute('title', sourceEl.textContent);

    card.querySelector('.card-copy-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const termName = entity.term || entity.name || '';
      const descEl = card.querySelector('.card-desc');
      const desc = descEl ? descEl.textContent : '';
      const copyText = termName + (desc ? ' \u2014 ' + desc : '');
      copyToClipboard(copyText).then(() => {
        const btn = card.querySelector('.card-copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy text'; btn.classList.remove('copied'); }, 1500);
      });
    });

    card.querySelector('.card-share-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const descEl = card.querySelector('.card-desc');
      generateCardPNG({ ...entity, description: descEl ? descEl.textContent : entity.description });
    });

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
      descEl.textContent = inlineDesc;
      saveDescToHistory(inlineDesc);
      saveDescToKB(inlineDesc);
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a')) return;
      const timeEl = e.target.closest('.card-time');
      if (timeEl && timeEl.dataset.seek) { e.stopPropagation(); seekVideo(parseInt(timeEl.dataset.seek)); return; }
      toggleCardExpand(card);

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
            const fullDesc = contextData.description || '';
            descEl.textContent = fullDesc;
            saveDescToHistory(fullDesc);
            saveDescToKB(fullDesc);
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

    card.querySelector('.card-tellmore').addEventListener('click', (e) => {
      e.stopPropagation();
      const input = shadowRoot.querySelector('.ctx-ask-input');
      if (input) {
        const termName = entity.term || entity.name || '';
        input.value = 'Explain ' + termName + ' in more detail and why it matters in this video';
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    });

    const key = (entity.term || entity.name || '').toLowerCase();
    addCardButtons(card, key, entity);
    return card;
  }

  const SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'by', 'as', 'with']);

  function capitalizeTerm(term) {
    if (!term) return term;
    if (term !== term.toLowerCase()) return term;
    return term.split(' ').map((word, i) => {
      if (i > 0 && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
  }

  function formatTimestamp(sec) {
    if (!sec && sec !== 0) return '';
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function getVideoIdFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || '';
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    } catch (e) {}
    return '';
  }

  function generateStudyGuide(title, history, kb, videoUrl) {
    kb = kb || {};
    history.forEach(entry => {
      if (!entry.description) {
        const kbEntry = kb[(entry.term || '').toLowerCase()];
        if (kbEntry && kbEntry.description) entry.description = kbEntry.description;
      }
    });

    const videoId = getVideoIdFromUrl(videoUrl || '');
    function tsLink(sec) {
      if (!sec && sec !== 0) return '';
      const ts = formatTimestamp(sec);
      if (videoId) return `[${ts}](https://youtube.com/watch?v=${videoId}&t=${sec})`;
      return `[${ts}]`;
    }

    const insightEntries = history.filter(entry => (entry.type || '').toLowerCase() === 'insight');
    const entityEntries = history.filter(entry => (entry.type || '').toLowerCase() !== 'insight');

    const TYPE_ORDER = { person: 'People', people: 'People', event: 'Events', concept: 'Concepts', organization: 'Organizations', stock: 'Stocks', commodity: 'Commodities', ingredient: 'Ingredients' };
    const grouped = {};
    entityEntries.forEach(entry => {
      const t = (entry.type || 'other').toLowerCase();
      const label = TYPE_ORDER[t] || (t.charAt(0).toUpperCase() + t.slice(1));
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push(entry);
    });

    let guide = `# Study Guide: ${title}\n`;
    if (videoUrl) guide += `${videoUrl}\n`;
    guide += '\n';

    const sectionOrder = ['People', 'Events', 'Concepts', 'Organizations', 'Stocks', 'Commodities', 'Ingredients'];
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
      const ia = sectionOrder.indexOf(a), ib = sectionOrder.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    sortedKeys.forEach(label => {
      guide += `## ${label}\n`;
      grouped[label].forEach(ent => {
        const term = capitalizeTerm(ent.term);
        const ts = ent.elapsedSeconds != null ? tsLink(ent.elapsedSeconds) + ' ' : '';
        guide += `- ${ts}**${term}**${ent.description ? ' — ' + ent.description : ''}\n`;
      });
      guide += '\n';
    });

    if (insightEntries.length > 0) {
      guide += `## Insights & Tips\n`;
      insightEntries.forEach(ent => {
        const ts = ent.elapsedSeconds != null ? tsLink(ent.elapsedSeconds) + ' ' : '';
        guide += `- ${ts}\u{1F4A1} **${ent.term}**${ent.description ? ' — ' + ent.description : ''}\n`;
      });
      guide += '\n';
    }

    const withDesc = entityEntries.filter(h => h.description).slice(0, 5);
    if (withDesc.length > 0) {
      guide += `## Key Questions\n`;
      withDesc.forEach(ent => {
        const term = capitalizeTerm(ent.term);
        const t = (ent.type || '').toLowerCase();
        if (t === 'person' || t === 'people') {
          guide += `- Who is ${term} and why do they matter?\n`;
        } else if (t === 'event') {
          guide += `- What was ${term} and why does it matter?\n`;
        } else {
          guide += `- What is ${term} and why does it matter?\n`;
        }
      });
      guide += '\n';
    }

    guide += `---\nGenerated by Context Listener`;
    return guide;
  }

  function exportToNotion(sidebar, history, title, videoUrl) {
    chrome.storage.local.get(['notionToken', 'notionDatabaseId'], (data) => {
      if (data.notionToken && data.notionDatabaseId) {
        doNotionExport(data.notionToken, data.notionDatabaseId, history, title, videoUrl, sidebar);
      } else {
        showNotionModal(sidebar, (token, dbId) => {
          chrome.storage.local.set({ notionToken: token, notionDatabaseId: dbId });
          doNotionExport(token, dbId, history, title, videoUrl, sidebar);
        });
      }
    });
  }

  function showNotionModal(sidebar, onSave) {
    const modal = document.createElement('div');
    modal.className = 'ctx-notion-modal';
    modal.innerHTML = `
      <div class="ctx-notion-modal-inner">
        <div class="ctx-notion-modal-title">Connect Notion</div>
        <input class="ctx-notion-modal-input" id="notion-token-input" type="text" placeholder="Notion integration token">
        <input class="ctx-notion-modal-input" id="notion-db-input" type="text" placeholder="Database ID">
        <button class="ctx-notion-modal-save">Save & Export</button>
        <button class="ctx-notion-modal-cancel">Cancel</button>
      </div>
    `;
    modal.querySelector('.ctx-notion-modal-save').addEventListener('click', () => {
      const token = modal.querySelector('#notion-token-input').value.trim();
      const dbId = modal.querySelector('#notion-db-input').value.trim();
      if (token && dbId) {
        modal.remove();
        onSave(token, dbId);
      }
    });
    modal.querySelector('.ctx-notion-modal-cancel').addEventListener('click', () => modal.remove());
    // Stop keyboard events from leaking
    modal.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', e => e.stopPropagation());
      inp.addEventListener('keyup', e => e.stopPropagation());
      inp.addEventListener('keypress', e => e.stopPropagation());
    });
    sidebar.appendChild(modal);
  }

  function doNotionExport(token, databaseId, history, title, videoUrl, sidebar) {
    const entities = history.filter(h => h.type !== 'insight');
    const insights = history.filter(h => h.type === 'insight');
    const btn = sidebar.querySelector('.ctx-notion-btn');
    if (btn) { btn.textContent = 'Exporting...'; btn.disabled = true; }

    fetch('https://context-extension-zv8d.vercel.app/api/notion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, databaseId, title, entities, insights, videoUrl })
    })
    .then(res => res.ok ? res.json() : Promise.reject(res))
    .then(data => {
      if (btn) {
        btn.textContent = data.success ? 'Exported!' : 'Failed';
        setTimeout(() => { btn.textContent = 'Export to Notion'; btn.disabled = false; }, 2000);
      }
    })
    .catch(() => {
      if (btn) {
        btn.textContent = 'Export failed';
        setTimeout(() => { btn.textContent = 'Export to Notion'; btn.disabled = false; }, 2000);
      }
    });
  }

  function ensureSidebar() {
    if (shadowRoot) return shadowRoot.getElementById('cards');

    // Host element — inline styles so YouTube can't override positioning
    hostEl = document.createElement('div');
    hostEl.id = 'context-sidebar-host';
    hostEl.style.cssText = getHostPosition();
    hostEl.style.pointerEvents = 'none';

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
        <button class="ctx-clear-btn" title="Clear all history">&#x1F5D1; Clear</button>
        <div class="ctx-export-wrap" style="position:relative;"><button class="ctx-export-btn" title="Export study guide">&#x1F4CB;<span class="ctx-export-tooltip">Copied!</span></button><div class="ctx-export-menu"><button class="ctx-export-menu-item" data-action="clipboard">Copy to clipboard</button><button class="ctx-export-menu-item" data-action="gmail">Open in Gmail</button><button class="ctx-export-menu-item" data-action="gdocs">Open in Google Docs</button><button class="ctx-export-menu-item" data-action="download">Download as .txt</button></div></div>
        <button class="ctx-close-btn" title="Close sidebar">&#x2715;</button>
      </div>
    `;

    // Wire up close button
    header.querySelector('.ctx-close-btn').addEventListener('click', () => {
      closeSidebar();
    });

    // Wire up clear button with inline confirmation
    const clearBtn = header.querySelector('.ctx-clear-btn');
    let clearTimer = null;
    clearBtn.addEventListener('click', () => {
      if (clearBtn.dataset.confirming === 'true') return;
      clearBtn.dataset.confirming = 'true';
      const origHTML = clearBtn.innerHTML;
      clearBtn.innerHTML = '';
      const confirm = document.createElement('span');
      confirm.className = 'ctx-clear-confirm';
      confirm.innerHTML = 'Sure? ';
      const yesBtn = document.createElement('button');
      yesBtn.className = 'ctx-clear-confirm-link yes';
      yesBtn.textContent = 'Yes';
      const noBtn = document.createElement('button');
      noBtn.className = 'ctx-clear-confirm-link no';
      noBtn.textContent = 'No';
      confirm.appendChild(yesBtn);
      confirm.appendChild(noBtn);
      clearBtn.appendChild(confirm);
      function revert() {
        if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
        clearBtn.innerHTML = origHTML;
        clearBtn.dataset.confirming = 'false';
      }
      yesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetSidebar();
        chrome.storage.local.remove(['sessionHistory', 'knowledgeBase', 'sessionTranscript', 'pendingEntities', 'pendingInsights']);
        try { chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' }); } catch (e) {}
        revert();
      });
      noBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        revert();
      });
      clearTimer = setTimeout(revert, 3000);
    });

    // Wire up export menu
    const exportBtn = header.querySelector('.ctx-export-btn');
    const exportMenu = header.querySelector('.ctx-export-menu');

    exportBtn.addEventListener('click', (e) => {
      if (e.target.closest('.ctx-export-menu-item')) return;
      e.stopPropagation();
      exportMenu.classList.toggle('visible');
    });

    // Close menu when clicking outside
    sidebar.addEventListener('click', (e) => {
      if (!e.target.closest('.ctx-export-btn')) {
        exportMenu.classList.remove('visible');
      }
    });

    function getStudyGuideData(callback) {
      chrome.storage.local.get(['sessionHistory', 'capturingTabTitle', 'knowledgeBase', 'activeTabUrl'], (data) => {
        const history = data.sessionHistory || [];
        const title = data.capturingTabTitle || document.title || 'Untitled';
        const guide = generateStudyGuide(title, history, data.knowledgeBase || {}, data.activeTabUrl || window.location.href);
        callback({ guide, title });
      });
    }

    exportMenu.querySelector('[data-action="clipboard"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      getStudyGuideData(({ guide }) => {
        copyToClipboard(guide).then(() => {
          const tooltip = header.querySelector('.ctx-export-tooltip');
          tooltip.classList.add('visible');
          setTimeout(() => tooltip.classList.remove('visible'), 1500);
        });
      });
    });

    exportMenu.querySelector('[data-action="gmail"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      getStudyGuideData(({ guide, title }) => {
        const gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1&su=' +
          encodeURIComponent(title) + '&body=' + encodeURIComponent(guide);
        window.open(gmailUrl, '_blank');
      });
    });

    exportMenu.querySelector('[data-action="gdocs"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      getStudyGuideData(({ guide }) => {
        copyToClipboard(guide).then(() => {
          window.open('https://docs.google.com/document/create', '_blank');
          const tooltip = header.querySelector('.ctx-export-tooltip');
          tooltip.textContent = 'Copied \u2014 paste into doc';
          tooltip.classList.add('visible');
          setTimeout(() => {
            tooltip.classList.remove('visible');
            tooltip.textContent = 'Copied!';
          }, 3000);
        });
      });
    });

    exportMenu.querySelector('[data-action="download"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      getStudyGuideData(({ guide, title }) => {
        const blob = new Blob([guide], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10);
        const safeTitle = title.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').slice(0, 40);
        a.download = `context-${safeTitle}-${dateStr}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    });

    // Empty state
    const emptyState = document.createElement('div');
    emptyState.id = 'empty-state';
    emptyState.innerHTML = `
      <div class="ctx-waveform"><span></span><span></span><span></span><span></span></div>
      <div class="ctx-empty-text">Listening for context...</div>
      <div id="empty-kb-matches" style="margin-top:12px;width:100%;max-width:240px;"></div>
    `;

    // KB matches toggle header
    const kbToggle = document.createElement('div');
    kbToggle.className = 'kb-matches-toggle';
    kbToggle.textContent = '\u25B8 You\'ve explored related topics before';
    kbToggle.addEventListener('click', () => {
      const kbEl = shadowRoot.getElementById('empty-kb-matches');
      if (kbEl) {
        kbEl.classList.toggle('collapsed');
        kbToggle.textContent = kbEl.classList.contains('collapsed')
          ? '\u25B8 You\'ve explored related topics before'
          : '\u25BE You\'ve explored related topics before';
      }
    });
    emptyState.insertBefore(kbToggle, emptyState.querySelector('#empty-kb-matches'));

    // Pre-analysis briefing (Prompt 7)
    const briefingContainer = document.createElement('div');
    briefingContainer.id = 'empty-briefing';
    briefingContainer.style.cssText = 'margin-top:12px;width:100%;max-width:240px;transition:opacity 0.3s ease;';
    emptyState.appendChild(briefingContainer);

    chrome.storage.local.get(['capturingTabTitle', 'knowledgeBase', 'capturing'], (briefData) => {
      if (!briefData.capturing) return;
      const videoTitle = briefData.capturingTabTitle || document.title || '';
      if (!videoTitle) return;
      const descEl = document.querySelector('#description-inner');
      const videoDescription = descEl ? descEl.textContent.slice(0, 500) : '';
      const knownTerms = Object.values(briefData.knowledgeBase || {}).map(e => e.term).slice(0, 50);

      fetch('https://context-extension-zv8d.vercel.app/api/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoTitle, videoDescription, knownTerms })
      })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!data || !data.bullets || data.bullets.length === 0) return;
        if (hasCards) return; // Cards already arrived
        briefingContainer.innerHTML = '<div style="font-size:11px;color:#94a3b8;font-weight:600;margin-bottom:6px;">Before you watch:</div>' +
          data.bullets.map(b => `<div style="font-size:12px;color:#64748b;padding:3px 0;padding-left:12px;position:relative;"><span style="position:absolute;left:0;">\u2022</span>${escapeHtml(b)}</div>`).join('');
      })
      .catch(() => {});
    });

    // Smart empty state: show KB matches from previous sessions
    chrome.storage.local.get(['knowledgeBase', 'capturingTabTitle'], (data) => {
      const kb = data.knowledgeBase || {};
      const title = (data.capturingTabTitle || '').toLowerCase();
      const titleWords = title.split(/\s+/).filter(w => w.length > 3);
      const matchContainer = emptyState.querySelector('#empty-kb-matches');
      if (!matchContainer) return;

      if (titleWords.length > 0 && Object.keys(kb).length > 0) {
        const matches = Object.values(kb).filter(e => {
          const src = (e.source || '').toLowerCase();
          return titleWords.some(w => src.includes(w));
        }).slice(0, 3);

        if (matches.length > 0) {
          matchContainer.innerHTML =
            matches.map(m => `<div style="opacity:0.5;font-size:11px;color:#94a3b8;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);">${escapeHtml(m.term)} <span style="font-size:9px;color:#475569;">from a previous session</span></div>`).join('');
          const toggle = emptyState.querySelector('.kb-matches-toggle');
          if (toggle) toggle.classList.add('visible');
        } else {
          matchContainer.innerHTML = '<div style="font-size:12px;color:#64748b;">Terms, people, and concepts will appear here as they\'re mentioned.</div>';
        }
      } else {
        matchContainer.innerHTML = '<div style="font-size:12px;color:#64748b;">Terms, people, and concepts will appear here as they\'re mentioned.</div>';
      }
    });

    // Tab bar (hidden — single Live view)
    const tabBar = document.createElement('div');
    tabBar.className = 'ctx-tab-bar';

    function addToNotes() { /* no-op — Notes tab removed */ }

    function loadInlineQuiz(card, term, type, desc) {
      fetch('https://context-extension-zv8d.vercel.app/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities: [{ term, type, description: desc }], title: document.title })
      })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const questions = (data && data.questions) || [];
        if (questions.length === 0) return;
        const q = questions[0];
        const quizEl = document.createElement('div');
        quizEl.className = 'ctx-quiz-inline';
        quizEl.innerHTML = `<div class="ctx-quiz-inline-q">${escapeHtml(q.question)}</div>` +
          q.options.map((opt, i) => `<button class="ctx-quiz-inline-opt" data-idx="${i}">${escapeHtml(opt)}</button>`).join('');
        quizEl.querySelectorAll('.ctx-quiz-inline-opt').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const chosen = parseInt(btn.dataset.idx);
            quizEl.querySelectorAll('.ctx-quiz-inline-opt').forEach(b => { b.style.pointerEvents = 'none'; });
            if (chosen === q.correct) {
              btn.classList.add('correct');
              const check = document.createElement('span');
              check.className = 'ctx-quiz-check';
              check.textContent = ' \u2713';
              card.querySelector('.card-term').appendChild(check);
            } else {
              btn.classList.add('wrong');
              quizEl.querySelectorAll('.ctx-quiz-inline-opt')[q.correct].classList.add('correct');
            }
          });
        });
        card.appendChild(quizEl);
      })
      .catch(() => {});
    }

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

    // Cards container
    const cardContainer = document.createElement('div');
    cardContainer.id = 'cards';

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

    // Suggested questions
    const suggestionsBar = document.createElement('div');
    suggestionsBar.className = 'ctx-suggestions';
    let suggestionsTimer = null;
    let suggestionsOffset = 0;

    function generateSuggestionQ(entity) {
      const t = (entity.type || '').toLowerCase();
      const term = entity.term || '';
      if (t === 'person' || t === 'people') return `Who was ${term} and why did they matter?`;
      if (t === 'event') return `What caused ${term}?`;
      if (t === 'ingredient') return `Why use ${term} here?`;
      return `How did ${term} work?`;
    }

    function updateSuggestions() {
      chrome.storage.local.get('sessionHistory', (data) => {
        const history = (data.sessionHistory || []).filter(h => h.type !== 'insight');
        if (history.length < 10) { suggestionsBar.classList.remove('visible'); return; }
        const top = history.filter(h => h.term).slice(-6);
        if (top.length === 0) return;
        suggestionsBar.innerHTML = '';
        const shown = top.slice(suggestionsOffset % top.length, (suggestionsOffset % top.length) + 2);
        const pills = shown.length > 0 ? shown : top.slice(0, 2);
        pills.forEach(ent => {
          const pill = document.createElement('button');
          pill.className = 'ctx-suggestion-pill';
          const q = generateSuggestionQ(ent);
          pill.textContent = q.length > 45 ? q.slice(0, 42) + '...' : q;
          pill.addEventListener('click', () => {
            askInput.value = q;
            askInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          });
          suggestionsBar.appendChild(pill);
        });
        suggestionsBar.classList.add('visible');
        suggestionsOffset++;
      });
    }

    suggestionsTimer = setInterval(updateSuggestions, 30000);

    // Ask bar
    const askBar = document.createElement('div');
    askBar.className = 'ctx-ask-bar';
    const askInput = document.createElement('input');
    askInput.className = 'ctx-ask-input';
    askInput.type = 'text';
    askInput.placeholder = 'Ask about this video...';
    askBar.appendChild(askInput);

    // Stop keyboard events from leaking through Shadow DOM to YouTube
    askInput.addEventListener('keydown', (e) => e.stopPropagation());
    askInput.addEventListener('keyup', (e) => e.stopPropagation());
    askInput.addEventListener('keypress', (e) => e.stopPropagation());

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

        chrome.storage.local.get(['sessionTranscript', 'capturingTabTitle', 'sessionHistory'], (data) => {
          fetch('https://context-extension-zv8d.vercel.app/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question,
              sessionTranscript: data.sessionTranscript || '',
              videoTitle: data.capturingTabTitle || document.title || '',
              sessionEntities: (data.sessionHistory || []).filter(h => h.type !== 'insight').map(h => ({ term: h.term, type: h.type, description: h.description || '' })),
              sessionInsights: (data.sessionHistory || []).filter(h => h.type === 'insight').map(h => ({ insight: h.term, detail: h.description || '', category: h.category || '' }))
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
    sidebar.appendChild(tabBar);
    sidebar.appendChild(missedBar);
    sidebar.appendChild(listeningIndicator);
    sidebar.appendChild(emptyState);
    sidebar.appendChild(cardContainer);
    sidebar.appendChild(askResponse);
    sidebar.appendChild(suggestionsBar);
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
    // Fade out briefing
    const briefing = empty ? empty.querySelector('#empty-briefing') : null;
    if (briefing) { briefing.style.opacity = '0'; }
    if (empty) {
      empty.style.transition = 'opacity 0.2s ease';
      empty.style.opacity = '0';
      setTimeout(() => { empty.style.display = 'none'; }, 200);
    }
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
    if (!entities) entities = [];
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

    // Always clean up storage even if no entities survived dedup
    chrome.storage.local.remove('pendingEntities');

    if (entities.length === 0) return;

    console.log('[CONTENT] Rendering entities:', entities.map(e => e.term));

    // Check knowledge base for seen-before terms
    chrome.storage.local.get(['knowledgeBase', 'capturingTabTitle'], (kbData) => {
      const kb = kbData.knowledgeBase || {};
      const currentTitle = kbData.capturingTabTitle || document.title || '';

      // Annotate entities with KB info (seen before, source)
      entities.forEach(entity => {
        const term = (entity.term || entity.name || '').toLowerCase();
        const entry = kb[term];
        if (entry) {
          if (!entity.recontextualized) entity._kbSeen = true;
          if (entry.source && entry.source !== currentTitle) {
            entity._kbSource = entry.source;
          }
        }
      });

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

    // Update suggested questions
    if (typeof updateSuggestions === 'function') updateSuggestions();

    // Track last entity term (skip insights) and reset ask idle timer
    const lastEntity = limited.find(e => (e.type || '').toLowerCase() !== 'insight');
    if (lastEntity) {
      lastRenderedTerm = lastEntity.term || lastEntity.name || '';
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

        // Flash on new transcript
        strip.classList.remove('paused');
        strip.classList.add('flash');
        setTimeout(() => strip.classList.remove('flash'), 500);

        // Update listening dot speed
        const liDot = shadowRoot.querySelector('#listening-indicator .li-dot');
        if (liDot) liDot.style.animationDuration = '0.8s';

        // Reset silence timer
        if (window.__ctxSilenceTimer) clearTimeout(window.__ctxSilenceTimer);
        window.__ctxSilenceTimer = setTimeout(() => {
          strip.classList.add('paused');
          // Remove old indicator
          const old = strip.querySelector('.ctx-silence-indicator');
          if (old) old.remove();
          const ind = document.createElement('span');
          ind.className = 'ctx-silence-indicator';
          ind.textContent = '\u00B7 silence detected';
          strip.appendChild(ind);
          if (liDot) liDot.style.animationDuration = '2s';
        }, 8000);
      }
    }
    if (changes.sessionStart && changes.sessionStart.newValue) {
      isActiveTab((active) => {
        if (active) {
          trackSessionStart(changes.sessionStart.newValue);
          resetSidebar();
          chrome.storage.local.get('currentSessionId', (data) => {
            mySessionId = data.currentSessionId || null;
          });
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

          const watchNextEntries = history
            .filter(h => h.term)
            .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
            .slice(0, 3);
          const watchNextHTML = watchNextEntries.length > 0
            ? '<div style="margin-top: 12px; font-size: 10px; color: #6a6a8a;">Keep learning:</div>' +
              watchNextEntries.map(ent => {
                const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ent.term + ' explained');
                return '<a href="' + url + '" target="_blank" rel="noopener" style="display: block; font-size: 11px; color: #6366f1; text-decoration: none; padding: 2px 0; margin-top: 2px;">' + escapeHtml(ent.term) + ' explained \u2192</a>';
              }).join('')
            : '';

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
            <button class="ctx-notion-btn">Export to Notion</button>
            <button class="ctx-quiz-btn">Test yourself</button>
            ${watchNextHTML}
            <button class="ctx-session-summary-dismiss">Dismiss</button>
          `;

          summaryEl.querySelector('.ctx-session-summary-export').addEventListener('click', (e) => {
            e.stopPropagation();
            const guide = generateStudyGuide(title, history, kb, window.location.href);
            copyToClipboard(guide).then(() => {
              const btn = summaryEl.querySelector('.ctx-session-summary-export');
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Export study guide'; }, 1500);
            });
          });

          summaryEl.querySelector('.ctx-notion-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const sidebar = shadowRoot.getElementById('sidebar');
            if (sidebar) exportToNotion(sidebar, history, title, window.location.href);
          });

          summaryEl.querySelector('.ctx-quiz-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const quizBtn = summaryEl.querySelector('.ctx-quiz-btn');
            quizBtn.textContent = 'Loading...';
            quizBtn.disabled = true;

            const quizEntities = history
              .filter(h => h.term && h.description)
              .slice(0, 15)
              .map(h => ({ term: h.term, type: h.type || 'concept', description: h.description }));

            fetch('https://context-extension-zv8d.vercel.app/api/quiz', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entities: quizEntities, title })
            })
            .then(res => res.ok ? res.json() : Promise.reject(res))
            .then(data => {
              const questions = data.questions || [];
              if (questions.length === 0) {
                quizBtn.textContent = 'No questions generated';
                setTimeout(() => { quizBtn.textContent = 'Test yourself'; quizBtn.disabled = false; }, 1500);
                return;
              }

              const sidebar = shadowRoot.getElementById('sidebar');
              if (!sidebar) return;

              const overlay = document.createElement('div');
              overlay.className = 'ctx-quiz-overlay';
              let currentQ = 0;
              let score = 0;

              function renderQuestion() {
                const q = questions[currentQ];
                overlay.innerHTML = `
                  <button class="ctx-quiz-close">&times;</button>
                  <div style="font-size: 10px; color: #6a6a8a; margin-bottom: 12px;">Question ${currentQ + 1} of ${questions.length}</div>
                  <div class="ctx-quiz-question">${escapeHtml(q.question)}</div>
                  ${q.options.map((opt, i) => `<button class="ctx-quiz-option" data-idx="${i}">${escapeHtml(opt)}</button>`).join('')}
                `;

                overlay.querySelector('.ctx-quiz-close').addEventListener('click', () => overlay.remove());

                const optBtns = overlay.querySelectorAll('.ctx-quiz-option');
                optBtns.forEach(btn => {
                  btn.addEventListener('click', () => {
                    const chosen = parseInt(btn.dataset.idx);
                    const correct = q.correct;
                    optBtns.forEach(b => { b.style.pointerEvents = 'none'; });

                    if (chosen === correct) {
                      btn.classList.add('correct');
                      score++;
                    } else {
                      btn.classList.add('wrong');
                      optBtns[correct].classList.add('correct');
                    }

                    const nextBtn = document.createElement('button');
                    nextBtn.className = 'ctx-quiz-next';
                    nextBtn.textContent = currentQ < questions.length - 1 ? 'Next \u2192' : 'See results';
                    nextBtn.addEventListener('click', () => {
                      currentQ++;
                      if (currentQ < questions.length) {
                        renderQuestion();
                      } else {
                        renderScore();
                      }
                    });
                    overlay.appendChild(nextBtn);
                  });
                });
              }

              function renderScore() {
                overlay.innerHTML = `
                  <button class="ctx-quiz-close">&times;</button>
                  <div class="ctx-quiz-score">${score}/${questions.length} correct!</div>
                  <button class="ctx-quiz-next" style="align-self: center;">Done</button>
                `;
                overlay.querySelector('.ctx-quiz-close').addEventListener('click', () => overlay.remove());
                overlay.querySelector('.ctx-quiz-next').addEventListener('click', () => overlay.remove());
              }

              sidebar.style.position = 'relative';
              sidebar.appendChild(overlay);
              renderQuestion();
            })
            .catch(() => {
              quizBtn.textContent = 'Quiz failed';
              setTimeout(() => { quizBtn.textContent = 'Test yourself'; quizBtn.disabled = false; }, 1500);
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
    {
      const newEntities = changes.pendingEntities?.newValue || [];
      const newInsights = changes.pendingInsights?.newValue || [];
      if (newEntities.length === 0 && newInsights.length === 0) { /* skip — nothing to render */ }
      else {
        console.log('[CONTENT] onChanged fired, entities:', newEntities.length, 'insights:', newInsights.length);
        // Auto-collapse KB matches once cards start appearing
        const kbMatchesEl = shadowRoot?.getElementById('empty-kb-matches');
        if (kbMatchesEl && !kbMatchesEl.classList.contains('collapsed')) {
          kbMatchesEl.classList.add('collapsed');
          const kbToggleEl = shadowRoot?.querySelector('.kb-matches-toggle');
          if (kbToggleEl) {
            kbToggleEl.textContent = '\u25B8 You\'ve explored related topics before';
          }
        }
        chrome.storage.local.get('pendingSessionId', (data) => {
          if (mySessionId && data.pendingSessionId !== mySessionId) {
            console.log('[CONTENT] Ignoring data from different session');
            return;
          }
          isActiveTab((active) => {
            if (!active) {
              console.log('[CONTENT] Not the captured tab, ignoring');
              return;
            }
            // Render entities if any
            if (newEntities.length > 0) {
              console.log('[CONTENT] Rendering', newEntities.length, 'entities');
              renderCards(newEntities);
            }
            // Render insights if any — completely independent of entities
            if (newInsights.length > 0) {
              console.log('[CONTENT] Rendering', newInsights.length, 'insights');
              ensureSidebar();
              showCardsHideEmpty();
              const cards = shadowRoot.getElementById('cards');
              if (cards) {
                newInsights.forEach(insight => {
                  const key = insightKey(insight.insight || '');
                  if (key && shadowRoot.querySelector('[data-insight-key="' + key + '"]')) {
                    console.log('[CONTENT] Skipping duplicate insight card:', key);
                    return;
                  }
                  const card = createInsightCard(insight);
                  cards.prepend(card);
                  addToNotes(card);
                });
              }
            }
            // Clean up storage after rendering both
            chrome.storage.local.remove(['pendingEntities', 'pendingInsights']);
          });
        });
      }
    }
  });

  // Check for pending entities/insights on load
  chrome.storage.local.get(['pendingEntities', 'pendingInsights', 'sessionStart', 'activeTabUrl'], (data) => {
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
    const initEntities = data.pendingEntities || [];
    const initInsights = data.pendingInsights || [];
    console.log('[CONTENT] Initial check, entities:', initEntities.length, 'insights:', initInsights.length);
    if (initEntities.length > 0) {
      renderCards(initEntities);
    }
    if (initInsights.length > 0) {
      ensureSidebar();
      showCardsHideEmpty();
      const cards = shadowRoot.getElementById('cards');
      if (cards) {
        initInsights.forEach(insight => {
          const key = insightKey(insight.insight || '');
          if (key && shadowRoot.querySelector('[data-insight-key="' + key + '"]')) return;
          const card = createInsightCard(insight);
          cards.prepend(card);
          addToNotes(card);
        });
      }
    }
    if (initEntities.length > 0 || initInsights.length > 0) {
      chrome.storage.local.remove(['pendingEntities', 'pendingInsights']);
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
        chrome.storage.local.get(['pendingEntities', 'pendingInsights', 'pendingSessionId'], (data) => {
          if (chrome.runtime.lastError) return;
          if (mySessionId && data.pendingSessionId !== mySessionId) return;
          const pollEntities = data.pendingEntities || [];
          const pollInsights = data.pendingInsights || [];
          if (pollEntities.length === 0 && pollInsights.length === 0) return;
          console.log('[CONTENT] Poll fired, entities:', pollEntities.length, 'insights:', pollInsights.length);
          // Render entities if any
          if (pollEntities.length > 0) {
            renderCards(pollEntities);
          }
          // Render insights if any — completely independent of entities
          if (pollInsights.length > 0) {
            ensureSidebar();
            showCardsHideEmpty();
            const cards = shadowRoot.getElementById('cards');
            if (cards) {
              pollInsights.forEach(insight => {
                const key = insightKey(insight.insight || '');
                if (key && shadowRoot.querySelector('[data-insight-key="' + key + '"]')) {
                  console.log('[CONTENT] Skipping duplicate insight card (poll):', key);
                  return;
                }
                const card = createInsightCard(insight);
                cards.prepend(card);
                addToNotes(card);
              });
            }
          }
          // Only clean up if this is our session
          if (!mySessionId || data.pendingSessionId === mySessionId) {
            chrome.storage.local.remove(['pendingEntities', 'pendingInsights']);
          }
        });
      });
    } catch (e) {
      console.log('[CONTENT] Extension context gone, clearing interval');
      clearInterval(pollId);
    }
  }, 2000);

  // --- Keyboard shortcut: Ctrl+Shift+X to toggle sidebar ---
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'X') {
      e.preventDefault();
      if (hostEl && hostEl.dataset.open === 'true') {
        closeSidebar();
      } else {
        openSidebar();
      }
    }
  });

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
