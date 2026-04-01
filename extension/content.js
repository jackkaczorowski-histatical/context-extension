console.log('[CONTENT] Script loaded, guard=', !!window.__contextExtensionLoaded);

if (window.__contextExtensionLoaded) {
  console.log('[CONTENT] Already initialized, skipping duplicate injection');
} else {
  window.__contextExtensionLoaded = true;
  let isLightTheme = false;

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function copyRichToClipboard(html, plain) {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const plainBlob = new Blob([plain], { type: 'text/plain' });
      return navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': plainBlob })]).catch(() => copyToClipboard(plain));
    }
    return copyToClipboard(plain);
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
  let allowMultipleExpand = false;
  let transcriptAutoScroll = true;
  let consecutiveErrors = 0;
  let statusHideTimer = null;

  // Virtual scrolling state
  const VIRTUAL_THRESHOLD = 50;
  const VIRTUAL_BUFFER = 5;
  const HEIGHT_COLLAPSED = 44;
  const HEIGHT_EXPANDED = 120;
  const HEIGHT_INSIGHT = 80;
  const HEIGHT_DIVIDER = 48;
  let virtualCards = []; // { data, height, type: 'entity'|'insight'|'stock'|'divider', el: null }
  let virtualActive = false;
  let virtualScrollRAF = null;
  let virtualRenderedRange = { start: -1, end: -1 };
  const isYouTubeSite = window.location.hostname.includes('youtube.com');

  const TYPE_COLORS = {
    concept: '#6366f1',
    person: '#22c55e',
    people: '#22c55e',
    organization: '#a78bfa',
    event: '#38bdf8',
    place: '#14b8a6',
    technique: '#ec4899',
    why: '#eab308',
    tradeoff: '#f97316',
    stock: '#38bdf8',
    commodity: '#f97316',
    ingredient: '#ec4899'
  };

  function toggleCardExpand(card) {
    if (card.classList.contains('expanded')) {
      card.classList.remove('expanded');
      if (currentlyExpandedCard === card) currentlyExpandedCard = null;
    } else {
      if (!allowMultipleExpand && currentlyExpandedCard && currentlyExpandedCard !== card) {
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
      transform: translateX(100%);
      transition: transform 0.2s ease-out;
    }
    #sidebar[data-pos="left"] { transform: translateX(-100%); }
    #sidebar.open { transform: translateX(0) !important; }
    #header {
      display: flex; flex-direction: column; background: #12121c; flex-shrink: 0;
      overflow: visible;
    }
    .ctx-header-row1 {
      display: flex; align-items: center; justify-content: space-between;
      height: 40px; padding: 0 10px 0 12px;
    }
    .ctx-header-row1-left { display: flex; align-items: center; gap: 8px; }
    .ctx-header-row1-right { display: flex; align-items: center; gap: 6px; }
    .ctx-header-row2 {
      display: flex; align-items: center; justify-content: center;
      height: 28px; padding: 0 6px; gap: 2px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      position: relative;
    }
    .ctx-toolbar-btn {
      background: none; border: none; color: #4a4a6a; font-size: 10px;
      font-family: inherit; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.05em; cursor: pointer; padding: 4px 6px;
      line-height: 1; transition: color 0.15s; flex-shrink: 0; border-radius: 3px;
      white-space: nowrap;
    }
    .ctx-toolbar-btn:hover { color: #e0e0f0; }
    .ctx-toolbar-btn.active { color: #14b8a6; }
    .ctx-wordmark { font-size: 14px; font-weight: 700; color: #e0e0f0; letter-spacing: -0.01em; }
    .ctx-live { display: flex; align-items: center; gap: 5px; }
    .ctx-live-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #00e676;
      animation: ctx-pulse 2s ease-in-out infinite;
    }
    .ctx-live-text { font-size: 10px; color: #00e676; font-weight: 500; }
    .ctx-export-btn { position: relative; }
    .ctx-clear-btn:hover { color: #ef4444; }
    .ctx-close-btn {
      background: none; border: none; color: #64748b; font-size: 18px;
      cursor: pointer; padding: 0 2px; line-height: 1; transition: color 0.15s;
      flex-shrink: 0;
    }
    .ctx-close-btn:hover { color: #f8fafc; }
    .ctx-clear-confirm {
      position: absolute; right: 0; top: 50%; transform: translateY(-50%);
      background: #12121c; z-index: 10; padding: 4px 10px;
      font-size: 11px; color: #ef4444; display: inline-flex; align-items: center; gap: 6px;
      white-space: nowrap; border-radius: 4px;
    }
    .ctx-clear-confirm-link {
      border: none; font-size: 11px; cursor: pointer;
      font-family: inherit; padding: 3px 10px; border-radius: 4px;
      min-width: 28px; text-align: center; text-decoration: none;
    }
    .ctx-clear-confirm-link.yes { color: #ef4444; background: rgba(239,68,68,0.15); }
    .ctx-clear-confirm-link.no { color: #94a3b8; background: rgba(255,255,255,0.08); }
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
    .ctx-export-menu-item:disabled { color: #4a4a6a; cursor: default; }
    .ctx-export-menu-item:disabled:hover { background: none; }
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
    .context-card.card-dismissed { opacity: 0.5 !important; transition: opacity 0.2s; animation: none; }
    .context-card.card-dismissed:hover { opacity: 0.7; }
    .card-dismiss-inline {
      width: 18px; height: 18px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.15); background: none;
      color: rgba(255,255,255,0.3); font-size: 9px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: all 0.2s; padding: 0; line-height: 1; flex-shrink: 0;
      margin-left: auto; position: relative; z-index: 3;
    }
    .card-dismiss-inline:hover { border-color: rgba(0,230,118,0.5); color: #00e676; background: rgba(0,230,118,0.1); }
    .context-card.card-dismissed .card-dismiss-inline { border-color: rgba(0,230,118,0.6); color: #fff; background: #00c853; }
    .card-dismiss-inline.dismiss-starred { background: #eab308; border-color: #eab308; color: #fff; }
    .card-dismiss-inline.dismiss-starred:hover { background: #ca9a06; border-color: #ca9a06; }
    .card-quick-dismiss { display: none; }
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
    .card-seen { font-size: 9px; color: #94a3b8; font-style: italic; flex-shrink: 0; }
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
      width: 60px; height: 60px; max-width: 60px; max-height: 60px;
      object-fit: cover; border-radius: 6px; flex-shrink: 0;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .card-thumb-row {
      display: flex; gap: 10px; align-items: flex-start;
    }
    .card-thumbnail.loaded { opacity: 1; }
    .card-source { font-size: 10px; color: #94a3b8; margin-top: 4px; font-style: italic; }
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
      background: #0f1520; box-shadow: inset 2px 0 8px rgba(56, 189, 248, 0.15);
    }
    .context-card.stock-card:hover { background: #111a26; }
    .stock-ticker-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
    .stock-ticker { font-size: 18px; font-weight: 700; color: #e0e0f0; }
    .stock-company { font-size: 11px; color: #6a6a8a; }
    .stock-price-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
    .stock-price { font-size: 20px; font-weight: 700; color: #e0e0f0; }
    .stock-change { font-size: 13px; font-weight: 600; }
    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }
    .stock-52w-labels { display: flex; justify-content: space-between; font-size: 10px; color: #6a6a8a; margin-bottom: 2px; }
    .stock-52w-bar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; position: relative; margin: 2px 0 6px; }
    .stock-52w-fill { position: absolute; left: 0; top: 0; height: 100%; border-radius: 2px; background: #38bdf8; }
    .stock-52w-dot { position: absolute; top: -3px; width: 10px; height: 10px; background: #e0e0f0; border-radius: 50%; border: 2px solid #1a1a2e; }
    .stock-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; padding: 6px 0; border-top: 1px solid rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.06); margin: 6px 0; }
    .stock-stat-label { font-size: 10px; color: #6a6a8a; }
    .stock-stat-value { font-size: 12px; color: #c0c0d0; font-weight: 500; }
    .stock-stat-value.stock-div-highlight { color: #38bdf8; }
    .stock-footer { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
    .stock-footer-row { display: flex; justify-content: space-between; align-items: center; }
    .stock-volume-reactions { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
    .stock-volume-inline { display: flex; align-items: baseline; gap: 4px; }
    .stock-volume-inline .stock-stat-label { font-size: 10px; color: #6a6a8a; }
    .stock-volume-inline .stock-stat-value { font-size: 12px; color: #c0c0d0; font-weight: 500; }
    .stock-collapsed-price { font-size: 12px; font-weight: 600; color: #c0c0d0; margin-left: 4px; }
    .card-term .stock-change { font-size: 11px; margin-left: 2px; }
    .stock-yahoo-link { font-size: 11px; color: #6366f1; text-decoration: underline; }
    .stock-yahoo-link:hover { color: #818cf8; }
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
    .reaction-new { border: 1px solid #6a6a8a; color: #6a6a8a; }
    .reaction-new:hover { background: rgba(106,106,138,0.15); }
    .reaction-btn.active { transform: scale(1.1); }
    .reaction-known.active { background: rgba(34,197,94,0.2); border-color: #22c55e; color: #22c55e; }
    .reaction-new.active { background: rgba(234,179,8,0.2); border-color: #eab308; color: #eab308; }
    .card-highlighted { border-left-color: #eab308 !important; background: rgba(234,179,8,0.05); }
    .ctx-filter-bar {
      display: flex; gap: 6px; padding: 6px 16px;
      background: rgba(255,255,255,0.02); border-bottom: 1px solid rgba(255,255,255,0.04); flex-shrink: 0;
    }
    .ctx-filter-btn {
      font-size: 10px; padding: 3px 10px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.1); background: none;
      color: #64748b; cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .ctx-filter-btn:hover { border-color: rgba(255,255,255,0.2); color: #94a3b8; }
    .ctx-filter-btn.active { background: rgba(99,102,241,0.15); color: #818cf8; border-color: rgba(99,102,241,0.3); }
    .filter-hide-known .context-card.card-dismissed { display: none; }
    .filter-starred-only .context-card:not(.card-highlighted) { display: none; }
    .collapse-all .context-card:not(.insight-card) { }
    .collapse-all .context-card:not(.insight-card) .card-expand-area { display: none; }
    .collapse-all .context-card:not(.insight-card) .card-chevron { transform: rotate(0deg); }
    .collapse-all .context-card:not(.insight-card).expanded .card-preview-text { display: inline; }
    .reaction-label {
      font-size: 9px; color: #4a4a6a; margin-top: 2px; text-align: center;
    }
    .reaction-group { display: flex; flex-direction: column; align-items: center; }
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
    .feedback-msg { font-size: 11px; color: #3a3a5a; padding: 4px 0; text-align: center; }
    /* ─── KB matches ─── */
    #kb-matches-wrapper {
      margin-top: 12px;
      width: 100%;
      max-width: 240px;
      display: none;
    }
    #kb-matches-wrapper.visible { display: block; }
    #empty-kb-matches {
      max-height: 150px;
      overflow-y: auto;
      transition: max-height 0.3s ease, opacity 0.3s ease;
    }
    #kb-matches-wrapper.collapsed #empty-kb-matches {
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
    }
    .kb-matches-toggle:hover { color: #9a9ab0; }

    /* ─── Listen button ─── */
    #ctx-listen-btn {
      background: #00e676; color: white; border: none; border-radius: 50%;
      width: 32px; height: 32px; font-size: 14px; font-weight: 600; cursor: pointer;
      transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; padding: 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    #ctx-listen-btn:hover { background: #00c853; }
    #ctx-listen-btn.listening { background: #ef4444; }
    #ctx-listen-btn.listening:hover { background: #dc2626; }

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
      background: none; border: none; color: #999; font-size: 12px;
      cursor: pointer; padding: 2px 4px; line-height: 1;
      transition: color 0.15s; z-index: 1;
    }
    .ctx-ask-clear:hover { color: #ccc; }
    .ctx-ask-loading::after {
      content: ''; display: inline-block; width: 4px; height: 4px;
      background: #6a6a8a; border-radius: 50%;
      animation: ctx-dot-pulse 1s ease-in-out infinite;
    }

    /* ─── Light theme overrides ─── */
    #sidebar.light-theme { background: #f5f5f8; color: #1a1a2e; }
    .light-theme #header { background: #f5f5f8; }
    .light-theme .ctx-header-row2 { border-bottom-color: rgba(0,0,0,0.08); }
    .light-theme .ctx-wordmark { color: #1a1a2e; }
    .light-theme .ctx-toolbar-btn { color: #8a8aa0; }
    .light-theme .ctx-toolbar-btn:hover { color: #333; }
    .light-theme .ctx-clear-btn:hover { color: #ff5252; }
    .light-theme .ctx-close-btn { color: #9a9ab0; }
    .light-theme .ctx-close-btn:hover { color: #333; }
    .light-theme .ctx-clear-confirm { background: #f5f5f8; }
    .light-theme #empty-state { background: #f5f5f8; }
    .light-theme .ctx-waveform span { background: #c0c0d0; }
    .light-theme .ctx-empty-text { color: #7a7a9a; }
    .light-theme #transcript-strip { color: #475569; background: rgba(0,0,0,0.03); border-bottom-color: rgba(0,0,0,0.06); }
    .light-theme #cards { background: #f5f5f8; }
    .light-theme #cards::-webkit-scrollbar-thumb { background: #d0d0e0; }
    .light-theme #listening-indicator { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme #listening-indicator .li-dot { background: #9a9ab0; }
    .light-theme #listening-indicator .li-text { color: #9a9ab0; }
    .light-theme .context-card { background: #ffffff; border-bottom-color: rgba(0,0,0,0.06); }
    .light-theme .context-card:hover { background: #f0f0f5; }
    .light-theme .context-card.stock-card { background: #f0f7ff; }
    .light-theme .context-card.stock-card:hover { background: #e8f1fb; }
    .light-theme .stock-collapsed-price { color: #3a3a5a; }
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
    .light-theme .stock-52w-labels { color: #8a8aa0; }
    .light-theme .stock-52w-bar { background: rgba(0,0,0,0.06); }
    .light-theme .stock-52w-dot { background: #1a1a2e; border-color: #ffffff; }
    .light-theme .stock-stats { border-top-color: rgba(0,0,0,0.06); border-bottom-color: rgba(0,0,0,0.06); }
    .light-theme .stock-stat-label { color: #8a8aa0; }
    .light-theme .stock-stat-value { color: #3a3a5a; }
    .light-theme .stock-yahoo-link { color: #6366f1; }
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
    .light-theme .card-quick-dismiss { display: none; }
    .light-theme .card-dismiss-inline { border-color: rgba(0,0,0,0.15); color: rgba(0,0,0,0.3); }
    .light-theme .card-dismiss-inline:hover { border-color: rgba(5,150,105,0.5); color: #059669; background: rgba(5,150,105,0.1); }
    .light-theme .context-card.card-dismissed .card-dismiss-inline { border-color: rgba(5,150,105,0.6); color: #fff; background: #059669; }
    .light-theme .context-card.insight-card { background: rgba(245,158,11,0.05); border-left-color: #f59e0b; }
    .light-theme .context-card.insight-card:hover { background: rgba(245,158,11,0.1); }
    .light-theme .insight-text { color: #1a1a2e; }
    .light-theme .insight-detail { color: #5a5a7a; }
    .light-theme .feedback-msg { color: #9a9ab0; }
    .light-theme #ctx-listen-btn { background: #059669; color: white; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .light-theme #ctx-listen-btn:hover { background: #047857; }
    .light-theme #ctx-listen-btn.listening { background: #dc2626; }
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
    .light-theme .ctx-ask-clear { color: #999; }
    .light-theme .ctx-ask-clear:hover { color: #555; }
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

    .ctx-video-divider {
      padding: 6px 12px 2px 12px;
      margin: 4px 0;
    }
    .ctx-divider-prev {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .ctx-divider-label {
      font-size: 9px;
      color: rgba(255, 255, 255, 0.3);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .ctx-divider-link {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
      text-decoration: none;
      text-align: center;
      max-width: 90%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }
    .ctx-divider-link:hover {
      color: rgba(255, 255, 255, 0.8);
      text-decoration: underline;
    }
    .ctx-divider-count {
      font-size: 9px;
      color: rgba(255, 255, 255, 0.25);
    }
    .ctx-divider-line-full {
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
      margin-top: 6px;
    }
    .light-theme .ctx-divider-label { color: rgba(0, 0, 0, 0.3); }
    .light-theme .ctx-divider-link { color: rgba(0, 0, 0, 0.45); }
    .light-theme .ctx-divider-link:hover { color: rgba(0, 0, 0, 0.7); }
    .light-theme .ctx-divider-count { color: rgba(0, 0, 0, 0.2); }
    .light-theme .ctx-divider-line-full { background: rgba(0, 0, 0, 0.08); }

    .ctx-now-watching {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .ctx-now-watching-label {
      font-size: 9px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.3);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
    }
    .ctx-now-watching-title {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.6);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    /* ─── Onboarding overlay ─── */
    .ctx-onboarding {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: #12121c; z-index: 100;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 32px 24px; text-align: center;
    }
    .ctx-onboarding-title {
      font-size: 18px; font-weight: 700; color: #e0e0f0;
      margin-bottom: 16px; line-height: 1.3;
    }
    .ctx-onboarding-body {
      font-size: 13px; color: #94a3b8; line-height: 1.6;
      margin-bottom: 24px; max-width: 220px;
    }
    .ctx-onboarding-body ol {
      text-align: left; padding-left: 18px; margin: 0;
    }
    .ctx-onboarding-body ol li {
      margin-bottom: 6px;
    }
    .ctx-onboarding-link {
      display: inline-block; font-size: 11px; color: #14b8a6;
      text-decoration: underline; margin-bottom: 20px; cursor: pointer;
    }
    .ctx-onboarding-link:hover { color: #2dd4bf; }
    .ctx-onboarding-btn {
      background: #14b8a6; color: #0a0a14; border: none; border-radius: 8px;
      padding: 10px 24px; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: background 0.15s; font-family: inherit;
    }
    .ctx-onboarding-btn:hover { background: #0d9488; }
    .ctx-onboarding-dots {
      display: flex; gap: 8px; margin-top: 28px;
    }
    .ctx-onboarding-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #3a3a5a; transition: background 0.2s;
    }
    .ctx-onboarding-dot.active { background: #14b8a6; }
    .light-theme .ctx-onboarding { background: #f5f5f8; }
    .light-theme .ctx-onboarding-title { color: #1a1a2e; }
    .light-theme .ctx-onboarding-body { color: #64748b; }
    .light-theme .ctx-onboarding-btn { color: #fff; }
    .light-theme .ctx-onboarding-dot { background: #cbd5e1; }
    .light-theme .ctx-onboarding-dot.active { background: #14b8a6; }

    /* ─── Settings panel ─── */
    .ctx-settings-btn.active { color: #14b8a6; }
    .light-theme .ctx-settings-btn.active { color: #14b8a6; }
    .ctx-settings-panel {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: #12121c; z-index: 90;
      display: flex; flex-direction: column;
      overflow-y: auto; overflow-x: hidden;
      padding: 16px;
      transform: translateX(100%);
      transition: transform 0.2s ease-out;
    }
    .ctx-settings-panel.open { transform: translateX(0); }
    .light-theme .ctx-settings-panel { background: #f5f5f8; }
    .ctx-settings-heading {
      font-size: 15px; font-weight: 700; color: #e0e0f0; margin-bottom: 16px;
    }
    .light-theme .ctx-settings-heading { color: #1a1a2e; }
    .ctx-settings-section {
      margin-bottom: 20px;
    }
    .ctx-settings-label {
      font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 8px;
    }
    .light-theme .ctx-settings-label { color: #64748b; }
    .ctx-settings-radios {
      display: flex; gap: 6px;
    }
    .ctx-settings-radio {
      flex: 1; padding: 6px 0; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1);
      background: none; color: #94a3b8; font-size: 11px; font-weight: 500;
      cursor: pointer; text-align: center; transition: all 0.15s; font-family: inherit;
    }
    .ctx-settings-radio:hover { border-color: rgba(255,255,255,0.2); color: #e0e0f0; }
    .ctx-settings-radio.active { border-color: #14b8a6; color: #14b8a6; background: rgba(20,184,166,0.08); }
    .light-theme .ctx-settings-radio { border-color: rgba(0,0,0,0.12); color: #64748b; }
    .light-theme .ctx-settings-radio:hover { border-color: rgba(0,0,0,0.25); color: #1a1a2e; }
    .light-theme .ctx-settings-radio.active { border-color: #14b8a6; color: #0d9488; background: rgba(20,184,166,0.08); }
    .ctx-settings-chips {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .ctx-settings-chip {
      padding: 5px 10px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.1);
      background: none; color: #64748b; font-size: 11px; cursor: pointer;
      transition: all 0.15s; font-family: inherit; white-space: nowrap;
    }
    .ctx-settings-chip:hover { border-color: rgba(255,255,255,0.2); color: #94a3b8; }
    .ctx-settings-chip.active { border-color: #14b8a6; color: #14b8a6; background: rgba(20,184,166,0.08); }
    .light-theme .ctx-settings-chip { border-color: rgba(0,0,0,0.12); color: #94a3b8; }
    .light-theme .ctx-settings-chip:hover { border-color: rgba(0,0,0,0.25); color: #64748b; }
    .light-theme .ctx-settings-chip.active { border-color: #14b8a6; color: #0d9488; background: rgba(20,184,166,0.08); }
    .ctx-settings-toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 0;
    }
    .ctx-settings-toggle-label {
      font-size: 12px; color: #e0e0f0;
    }
    .light-theme .ctx-settings-toggle-label { color: #1a1a2e; }
    .ctx-settings-toggle {
      position: relative; width: 36px; height: 20px; border-radius: 10px;
      background: #3a3a5a; cursor: pointer; transition: background 0.2s;
      border: none; padding: 0; flex-shrink: 0;
    }
    .ctx-settings-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #94a3b8; transition: all 0.2s;
    }
    .ctx-settings-toggle.on { background: #14b8a6; }
    .ctx-settings-toggle.on::after { left: 18px; background: #fff; }
    .light-theme .ctx-settings-toggle { background: #cbd5e1; }
    .light-theme .ctx-settings-toggle::after { background: #fff; }
    .light-theme .ctx-settings-toggle.on { background: #14b8a6; }
    .ctx-settings-done {
      margin-top: auto; padding: 10px 0; border-radius: 8px;
      background: #14b8a6; color: #0a0a14; border: none; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
      font-family: inherit; width: 100%;
    }
    .ctx-settings-done:hover { background: #0d9488; }
    .light-theme .ctx-settings-done { color: #fff; }
    #cards.hide-insights .context-card.insight-card { display: none; }

    /* ─── History panel ─── */
    .ctx-history-btn.active { color: #14b8a6; }
    .light-theme .ctx-history-btn.active { color: #14b8a6; }
    .ctx-history-panel {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: #12121c; z-index: 89;
      display: flex; flex-direction: column;
      overflow: hidden;
      transform: translateX(100%);
      transition: transform 0.2s ease-out;
    }
    .ctx-history-panel.open { transform: translateX(0); }
    .light-theme .ctx-history-panel { background: #f5f5f8; }
    .ctx-history-header {
      display: flex; align-items: center; padding: 12px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
    }
    .light-theme .ctx-history-header { border-bottom-color: rgba(0,0,0,0.08); }
    .ctx-history-back {
      background: none; border: none; color: #94a3b8; font-size: 13px;
      cursor: pointer; padding: 0; font-family: inherit; transition: color 0.15s;
    }
    .ctx-history-back:hover { color: #e0e0f0; }
    .light-theme .ctx-history-back:hover { color: #1a1a2e; }
    .ctx-history-title {
      font-size: 14px; font-weight: 700; color: #e0e0f0; margin-left: 10px;
    }
    .light-theme .ctx-history-title { color: #1a1a2e; }
    .ctx-history-list {
      flex: 1; overflow-y: auto; padding: 8px 0;
    }
    .ctx-history-list::-webkit-scrollbar { width: 4px; }
    .ctx-history-list::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
    .ctx-history-empty {
      text-align: center; color: #64748b; font-size: 12px; padding: 40px 16px;
    }
    .ctx-history-item {
      padding: 10px 16px; cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      transition: background 0.15s;
    }
    .ctx-history-item:hover { background: rgba(255,255,255,0.03); }
    .light-theme .ctx-history-item { border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme .ctx-history-item:hover { background: rgba(0,0,0,0.03); }
    .ctx-history-item-title {
      font-size: 12px; font-weight: 600; color: #e0e0f0;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; line-height: 1.4; margin-bottom: 4px;
    }
    .light-theme .ctx-history-item-title { color: #1a1a2e; }
    .ctx-history-item-meta {
      display: flex; align-items: center; gap: 8px; font-size: 10px; color: #64748b;
    }
    .ctx-history-item-badge {
      background: rgba(20,184,166,0.12); color: #14b8a6;
      padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 500;
    }
    .ctx-history-item-chevron {
      float: right; color: #3a3a5a; font-size: 12px; margin-top: 2px;
      transition: transform 0.2s;
    }
    .ctx-history-item.expanded .ctx-history-item-chevron { transform: rotate(90deg); }
    .ctx-history-item-detail {
      display: none; padding-top: 10px;
    }
    .ctx-history-item.expanded .ctx-history-item-detail { display: block; }
    .ctx-history-entity {
      padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .ctx-history-entity:last-child { border-bottom: none; }
    .ctx-history-entity-term {
      font-size: 12px; font-weight: 600; color: #e0e0f0;
    }
    .light-theme .ctx-history-entity-term { color: #1a1a2e; }
    .ctx-history-entity-type {
      font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px;
      margin-left: 6px; text-transform: uppercase; vertical-align: middle;
    }
    .ctx-history-entity-desc {
      font-size: 11px; color: #94a3b8; margin-top: 2px;
    }
    .light-theme .ctx-history-entity-desc { color: #64748b; }
    .ctx-history-insight {
      padding: 6px 0; border-left: 2px solid #f59e0b; padding-left: 8px;
      margin: 4px 0;
    }
    .ctx-history-insight-text {
      font-size: 12px; font-weight: 600; color: #fbbf24;
    }
    .ctx-history-insight-detail {
      font-size: 11px; color: #94a3b8; margin-top: 2px;
    }
    .light-theme .ctx-history-insight-detail { color: #64748b; }
    .ctx-history-clear {
      padding: 12px 16px; text-align: center; flex-shrink: 0;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .light-theme .ctx-history-clear { border-top-color: rgba(0,0,0,0.06); }
    .ctx-history-clear-link {
      background: none; border: none; color: #ef4444; font-size: 11px;
      cursor: pointer; font-family: inherit; opacity: 0.7; transition: opacity 0.15s;
    }
    .ctx-history-clear-link:hover { opacity: 1; }

    /* ─── View tabs (Cards / Transcript) ─── */
    .ctx-view-tabs {
      display: flex; flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      background: #12121c;
    }
    .light-theme .ctx-view-tabs { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.08); }
    .ctx-view-tab {
      flex: 1; padding: 8px 0; background: none; border: none;
      border-bottom: 2px solid transparent;
      color: #64748b; font-size: 12px; font-weight: 600;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
      text-align: center;
    }
    .ctx-view-tab:hover { color: #94a3b8; }
    .ctx-view-tab.active { color: #14b8a6; border-bottom-color: #14b8a6; }
    .light-theme .ctx-view-tab { color: #94a3b8; }
    .light-theme .ctx-view-tab:hover { color: #64748b; }
    .light-theme .ctx-view-tab.active { color: #0d9488; border-bottom-color: #0d9488; }

    /* ─── Transcript view ─── */
    .ctx-transcript-view {
      display: none; flex-direction: column; flex: 1; overflow: hidden;
    }
    .ctx-transcript-view.active { display: flex; }
    .ctx-cards-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .ctx-cards-wrap.hidden { display: none; }
    .ctx-transcript-scroll {
      flex: 1; overflow-y: auto; padding: 12px 16px;
      font-size: 12px; line-height: 1.6; color: #e0e0f0;
    }
    .ctx-transcript-scroll::-webkit-scrollbar { width: 4px; }
    .ctx-transcript-scroll::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
    .light-theme .ctx-transcript-scroll { color: #1a1a2e; }
    .light-theme .ctx-transcript-scroll::-webkit-scrollbar-thumb { background: #d0d0e0; }
    .ctx-transcript-chunk {
      margin-bottom: 8px;
    }
    .ctx-transcript-time {
      font-size: 10px; color: #4a4a6a; font-weight: 500; margin-right: 6px;
      font-variant-numeric: tabular-nums;
    }
    .light-theme .ctx-transcript-time { color: #94a3b8; }
    .ctx-transcript-text {
      color: #c8c8e0;
    }
    .light-theme .ctx-transcript-text { color: #374151; }
    .ctx-transcript-highlight {
      border-radius: 2px; padding: 0 1px;
      font-weight: 600;
    }
    .ctx-transcript-empty {
      text-align: center; color: #4a4a6a; padding: 40px 16px; font-size: 12px;
    }
    .light-theme .ctx-transcript-empty { color: #94a3b8; }
    .ctx-transcript-footer {
      flex-shrink: 0; padding: 8px 16px;
      border-top: 1px solid rgba(255,255,255,0.06);
      background: #12121c;
    }
    .light-theme .ctx-transcript-footer { background: #f5f5f8; border-top-color: rgba(0,0,0,0.06); }
    .ctx-transcript-copy {
      width: 100%; padding: 7px 0; border-radius: 6px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
      color: #94a3b8; font-size: 11px; font-weight: 500;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .ctx-transcript-copy:hover { background: rgba(255,255,255,0.1); color: #e0e0f0; }
    .light-theme .ctx-transcript-copy { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.08); color: #64748b; }
    .light-theme .ctx-transcript-copy:hover { background: rgba(0,0,0,0.08); color: #1a1a2e; }

    /* ─── Error status bar ─── */
    .ctx-status-bar {
      display: none; align-items: center; gap: 6px;
      padding: 6px 16px; font-size: 11px; flex-shrink: 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      transition: background 0.3s, color 0.3s;
    }
    .ctx-status-bar.visible { display: flex; }
    .ctx-status-bar.warning {
      background: rgba(245,158,11,0.08); color: #fbbf24;
      animation: ctx-status-pulse 2s ease-in-out infinite;
    }
    .ctx-status-bar.error {
      background: rgba(239,68,68,0.1); color: #f87171;
      animation: none;
    }
    .ctx-status-bar.success {
      background: rgba(34,197,94,0.08); color: #4ade80;
      animation: none;
    }
    @keyframes ctx-status-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .ctx-status-icon { flex-shrink: 0; }
    .ctx-status-text { flex: 1; }
    .light-theme .ctx-status-bar.warning { background: rgba(245,158,11,0.1); color: #d97706; }
    .light-theme .ctx-status-bar.error { background: rgba(239,68,68,0.08); color: #dc2626; }
    .light-theme .ctx-status-bar.success { background: rgba(34,197,94,0.1); color: #16a34a; }

    /* ─── Virtual scrolling ─── */
    .ctx-virtual-spacer-top, .ctx-virtual-spacer-bottom {
      flex-shrink: 0; width: 100%; pointer-events: none;
    }
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
    if (!document.body) return;

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
    if (!document.body) return;
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
    return `position:fixed;top:0;${pos}:0;width:0;height:100vh;z-index:2147483647;overflow:hidden;${border}background:${bg};pointer-events:none;margin:0;padding:0;`;
  }

  function applySidebarPosition() {
    if (!hostEl) return;
    const isOpen = hostEl.dataset.open === 'true';
    hostEl.style.cssText = getHostPosition();
    if (isOpen) {
      hostEl.style.width = '280px';
      hostEl.style.pointerEvents = 'auto';
    }
    const sidebar = shadowRoot?.getElementById('sidebar');
    if (sidebar) {
      sidebar.dataset.pos = settings.sidebarPosition || 'right';
      if (isOpen) sidebar.classList.add('open');
    }
  }

  function showOnboarding(sidebar) {
    const steps = [
      {
        title: 'Context Listener',
        body: 'Real-time contextual intelligence for any audio on the web. Entities, insights, and stock data \u2014 extracted live as you watch or listen.',
        btn: 'Get Started \u2192'
      },
      {
        title: 'How it works',
        body: '<ol><li>Open any video, podcast, or live stream</li><li>Click Start to begin capturing audio</li><li>Watch as entities and insights appear in real-time</li></ol>',
        btn: 'Next \u2192'
      },
      {
        title: 'Your privacy',
        body: 'Audio is processed by Deepgram for transcription and Anthropic for entity extraction. No audio or transcripts are stored on any server. All data stays in your browser\u2019s local storage. You can clear everything anytime.',
        btn: 'I understand, let\u2019s go \u2192',
        link: { text: 'Read full privacy policy', href: 'https://context-extension-zv8d.vercel.app/privacy' }
      }
    ];

    let current = 0;
    const overlay = document.createElement('div');
    overlay.className = 'ctx-onboarding';

    function render() {
      const step = steps[current];
      overlay.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'ctx-onboarding-title';
      title.textContent = step.title;
      overlay.appendChild(title);

      const body = document.createElement('div');
      body.className = 'ctx-onboarding-body';
      body.innerHTML = step.body;
      overlay.appendChild(body);

      if (step.link) {
        const link = document.createElement('a');
        link.className = 'ctx-onboarding-link';
        link.textContent = step.link.text;
        link.href = step.link.href;
        link.target = '_blank';
        link.rel = 'noopener';
        overlay.appendChild(link);
      }

      const btn = document.createElement('button');
      btn.className = 'ctx-onboarding-btn';
      btn.textContent = step.btn;
      btn.addEventListener('click', () => {
        if (current < steps.length - 1) {
          current++;
          render();
        } else {
          chrome.storage.local.set({ onboardingComplete: true });
          overlay.remove();
        }
      });
      overlay.appendChild(btn);

      const dots = document.createElement('div');
      dots.className = 'ctx-onboarding-dots';
      for (let i = 0; i < steps.length; i++) {
        const dot = document.createElement('div');
        dot.className = 'ctx-onboarding-dot' + (i === current ? ' active' : '');
        dots.appendChild(dot);
      }
      overlay.appendChild(dots);
    }

    render();
    sidebar.appendChild(overlay);
  }

  function openSidebar() {
    if (!hostEl) return;
    hostEl.dataset.open = 'true';
    hostEl.style.width = '280px';
    hostEl.style.pointerEvents = 'auto';
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    document.documentElement.style.setProperty('margin-' + pos, '280px');
    const sidebar = shadowRoot?.getElementById('sidebar');
    if (sidebar) {
      sidebar.dataset.pos = settings.sidebarPosition || 'right';
      sidebar.offsetHeight; // force reflow
      sidebar.classList.add('open');

      // Show onboarding on first run
      if (!sidebar.querySelector('.ctx-onboarding')) {
        chrome.storage.local.get('onboardingComplete', (data) => {
          if (!data.onboardingComplete) {
            showOnboarding(sidebar);
          }
        });
      }
    }
    chrome.storage.local.set({ sidebarOpen: true });
  }

  function closeSidebar() {
    if (!hostEl) return;
    // Dismiss any open overlays first
    if (shadowRoot) {
      const menu = shadowRoot.querySelector('.ctx-export-menu');
      if (menu) menu.classList.remove('visible');
      const confirm = shadowRoot.querySelector('.ctx-clear-confirm');
      if (confirm) confirm.remove();
    }
    hostEl.dataset.open = 'false';
    hostEl.style.pointerEvents = 'none';
    document.documentElement.style.removeProperty('margin-left');
    document.documentElement.style.removeProperty('margin-right');
    const sidebar = shadowRoot?.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('open');
    setTimeout(() => {
      if (hostEl && hostEl.dataset.open !== 'true') {
        hostEl.style.width = '0';
      }
    }, 250);
    chrome.storage.local.set({ sidebarOpen: false });
  }

  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (settings.autoHide && hostEl) {
      autoHideTimer = setTimeout(() => closeSidebar(), 30000);
    }
  }

  function addCardButtons(card, key, entity, container) {
    const expandArea = container || card.querySelector('.card-expand-area');
    if (!expandArea) return;

    const row = document.createElement('div');
    row.className = 'reaction-row';

    const reactionDefs = [
      { cls: 'reaction-known', icon: '\u2713', label: 'Knew this', reaction: 'known' },
      { cls: 'reaction-new', icon: '\u2605', label: 'New to me', reaction: 'new' }
    ];

    function applyReactionVisuals(reaction) {
      card.classList.remove('card-dismissed', 'card-highlighted');
      row.querySelectorAll('.reaction-btn').forEach(b => b.classList.remove('active'));
      const dismissEl = card.querySelector('.card-dismiss-inline');
      if (dismissEl) {
        dismissEl.classList.remove('dismiss-starred');
        dismissEl.textContent = '\u2713';
      }
      if (!reaction) return;
      if (reaction === 'known') {
        card.classList.add('card-dismissed');
      } else if (reaction === 'new') {
        card.classList.add('card-highlighted');
        if (dismissEl) {
          dismissEl.classList.add('dismiss-starred');
          dismissEl.textContent = '\u2605';
        }
      }
      const activeBtn = row.querySelector('.reaction-' + reaction);
      if (activeBtn) activeBtn.classList.add('active');
    }

    // Restore reaction state on render
    chrome.storage.local.get('cardReactions', (data) => {
      const reactions = data.cardReactions || {};
      if (reactions[key]) applyReactionVisuals(reactions[key].reaction);
    });

    reactionDefs.forEach(({ cls, icon, label, reaction }) => {
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
        const wasActive = btn.classList.contains('active');

        chrome.storage.local.get(['cardReactions', 'dismissedEntities'], (data) => {
          const reactions = data.cardReactions || {};
          let dismissed = data.dismissedEntities || [];

          // Remove previous dismiss effect regardless
          dismissed = dismissed.filter(k => k !== key);

          if (wasActive) {
            // Un-select: remove reaction entirely
            delete reactions[key];
            applyReactionVisuals(null);
          } else {
            // Set new reaction (replaces any previous)
            reactions[key] = { reaction, timestamp: Date.now(), type: entity.type || 'other' };
            if (reaction === 'known') {
              dismissed.push(key);
            }
            applyReactionVisuals(reaction);
          }

          chrome.storage.local.set({ cardReactions: reactions, dismissedEntities: dismissed });
        });
      });

      row.appendChild(group);
    });

    expandArea.appendChild(row);
  }

  const SHOP_KEYWORDS = /setup|gear|tackle|recipe|ingredients|build|diy|unboxing|what\s+i\s+use|my\s+favorite|best\s+lures|starter\s+kit/i;
  const EXCLUDE_KEYWORDS = /history|politics|war|battle|election|president|congress|military|wwi|wwii|world\s*war|how\s+it\s+works|how\s+they\s+work|explained|science|economics|what\s+is|how\s+does/i;
  const SHOP_ENTITY_TYPES = new Set(['concept', 'organization']);
  const EXCLUDE_ENTITY_TYPES = new Set(['person', 'people', 'event']);

  function shouldShowShopLink(entity, videoTitle) {
    const type = (entity.type || '').toLowerCase();
    if (EXCLUDE_ENTITY_TYPES.has(type)) return false;
    if (EXCLUDE_KEYWORDS.test(videoTitle)) return false;
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
      <div class="card-row">
        <span class="insight-category">\u{1F4A1} ${category}</span>
        <span class="card-term" style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px; display:inline-block; vertical-align:middle;">${escapeHtml(shortInsight)}</span>
        <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
        <span class="card-chevron">&#x203A;</span>
        <span class="card-dismiss-inline" title="Dismiss">\u2713</span>
      </div>
      <div class="card-expand-area">
        <div class="insight-text">${escapeHtml(insightText)}</div>
        ${detail ? `<div class="insight-detail">${detail}</div>` : ''}
        <button class="card-copy-btn">Copy text</button>
      </div>
    `;

    const insightDismissKey = (insight.insight || '').toLowerCase();
    const iDismissEl = card.querySelector('.card-dismiss-inline');
    chrome.storage.local.get('dismissedEntities', (data) => {
      const dismissed = data.dismissedEntities || [];
      if (dismissed.includes(insightDismissKey)) {
        card.classList.add('card-dismissed');
        if (iDismissEl) iDismissEl.title = 'Restore';
      }
    });
    if (iDismissEl) {
      iDismissEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        card.classList.toggle('card-dismissed');
        const isDismissed = card.classList.contains('card-dismissed');
        iDismissEl.title = isDismissed ? 'Restore' : 'Dismiss';
        chrome.storage.local.get('dismissedEntities', (data) => {
          let dismissed = data.dismissedEntities || [];
          if (isDismissed) {
            if (!dismissed.includes(insightDismissKey)) dismissed.push(insightDismissKey);
          } else {
            dismissed = dismissed.filter(k => k !== insightDismissKey);
          }
          chrome.storage.local.set({ dismissedEntities: dismissed });
        });
      });
    }

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

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-dismiss-inline') || e.target.closest('.card-quick-dismiss')) return;
      if (e.target.closest('a')) return;
      const timeEl = e.target.closest('.card-time');
      if (timeEl && timeEl.dataset.seek) { e.stopPropagation(); seekVideo(parseInt(timeEl.dataset.seek)); return; }
      toggleCardExpand(card);
    });

    return card;
  }

  function createStockCard(entity) {
    console.log('[CONTENT] Stock card data:', JSON.stringify(entity));

    // If entity has no ticker AND no price, don't render an empty stock card
    if (!entity.ticker && entity.price == null) {
      console.warn('[CONTENT] Stock entity has no ticker or price — rendering as generic card');
      return createGenericCard(entity);
    }

    const card = document.createElement('div');
    card.className = 'context-card stock-card expanded';
    const color = getTypeColor('stock');

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const vt = formatVideoTime();

    let expandContent;
    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changePctVal = parseFloat(entity.changePercent) || 0;
      const changeClass = changeVal >= 0 ? 'positive' : 'negative';
      const changePrefix = changeVal >= 0 ? '+' : '';
      const pctPrefix = changePctVal >= 0 ? '+' : '';

      card.style.borderLeftColor = color;

      // 52-week range section
      let rangeHTML = '';
      const low52 = entity.fiftyTwoWeekLow != null ? parseFloat(entity.fiftyTwoWeekLow) : null;
      const high52 = entity.fiftyTwoWeekHigh != null ? parseFloat(entity.fiftyTwoWeekHigh) : null;
      if (low52 != null && high52 != null && high52 > low52) {
        const pct = Math.max(0, Math.min(100, ((price - low52) / (high52 - low52)) * 100));
        rangeHTML = `
          <div class="stock-52w-labels">
            <span>52w low: $${low52.toFixed(2)}</span>
            <span>52w high: $${high52.toFixed(2)}</span>
          </div>
          <div class="stock-52w-bar">
            <div class="stock-52w-fill" style="width:${pct.toFixed(1)}%"></div>
            <div class="stock-52w-dot" style="left:calc(${pct.toFixed(1)}% - 5px)"></div>
          </div>
        `;
      }

      // Stats grid — only show non-null values (volume handled separately)
      const stats = [];
      if (entity.marketCap != null) stats.push({ label: 'Mkt cap', value: escapeHtml(String(entity.marketCap)) });
      if (entity.peRatio != null) stats.push({ label: 'P/E ratio', value: escapeHtml(String(entity.peRatio)) });
      if (entity.dividendYield != null) {
        const divHighlight = parseFloat(entity.dividendYield) > 3 ? ' stock-div-highlight' : '';
        stats.push({ label: 'Div yield', value: escapeHtml(String(entity.dividendYield)) + '%', cls: divHighlight });
      }

      let statsHTML = '';
      if (stats.length > 0) {
        const cells = stats.map(s =>
          `<div><div class="stock-stat-label">${s.label}</div><div class="stock-stat-value${s.cls || ''}">${s.value}</div></div>`
        ).join('');
        statsHTML = `<div class="stock-stats">${cells}</div>`;
      }

      // Volume inline (shown on same row as reaction buttons)
      let volumeHTML = '';
      if (entity.volume != null) {
        volumeHTML = `<div class="stock-volume-inline"><span class="stock-stat-label">Vol</span><span class="stock-stat-value">${escapeHtml(String(entity.volume))}</span></div>`;
      }

      // Yahoo Finance link
      const yahooURL = 'https://finance.yahoo.com/quote/' + encodeURIComponent(entity.ticker || '');

      expandContent = `
        <div class="stock-price-row">
          <span class="stock-price">$${price.toFixed(2)}</span>
          <span class="stock-change ${changeClass}">${changePrefix}${changeVal.toFixed(2)} (${pctPrefix}${changePctVal.toFixed(2)}%)</span>
        </div>
        ${rangeHTML}
        ${statsHTML}
        <div class="stock-volume-reactions">
          ${volumeHTML}
          <div class="stock-footer-buttons"></div>
        </div>
        <div class="stock-footer">
          <div class="stock-footer-row">
            <button class="card-tellmore">Tell me more</button>
            <a class="stock-yahoo-link" href="${yahooURL}" target="_blank" rel="noopener">Yahoo Finance &#x2192;</a>
          </div>
        </div>
      `;
    } else {
      console.warn('[CONTENT] Stock card missing price data for:', entity.ticker, '— falling back to description');
      card.style.borderLeftColor = color;
      const stockDesc = firstSentence(entity.description || '');
      const displayStockDesc = truncateHeadline(stockDesc);
      const yahooURL = 'https://finance.yahoo.com/quote/' + encodeURIComponent(entity.ticker || '');
      expandContent = `
        <div style="color:#999;font-size:12px;margin:4px 0;">Price unavailable</div>
        ${displayStockDesc ? `<div class="card-desc">${escapeHtml(displayStockDesc)}</div>` : ''}
        <div class="stock-volume-reactions">
          <div></div>
          <div class="stock-footer-buttons"></div>
        </div>
        <div class="stock-footer">
          <div class="stock-footer-row">
            <button class="card-tellmore">Tell me more</button>
            <a class="stock-yahoo-link" href="${yahooURL}" target="_blank" rel="noopener">Yahoo Finance &#x2192;</a>
          </div>
        </div>
      `;
    }

    let collapsedPriceHTML = '';
    if (entity.price != null && entity.price !== '') {
      const cp = parseFloat(entity.price);
      const cpDisplay = '$' + cp.toFixed(2);
      const cpPct = parseFloat(entity.changePercent) || 0;
      const cpClass = cpPct >= 0 ? 'positive' : 'negative';
      const cpSign = cpPct >= 0 ? '+' : '';
      collapsedPriceHTML = ` <span class="stock-collapsed-price">${cpDisplay}</span> <span class="stock-change ${cpClass}">${cpSign}${cpPct.toFixed(2)}%</span>`;
    }

    card.innerHTML = `
      <div class="card-row">
        <span class="card-type" style="color:${color}">STOCK</span>
        <span class="card-term">${ticker || companyName}${collapsedPriceHTML}</span>
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

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a') || e.target.closest('.card-quick-dismiss')) return;
      const timeEl = e.target.closest('.card-time');
      if (timeEl && timeEl.dataset.seek) { e.stopPropagation(); seekVideo(parseInt(timeEl.dataset.seek)); return; }
      toggleCardExpand(card);
    });

    const tellMoreBtn = card.querySelector('.card-tellmore');
    if (tellMoreBtn) {
      tellMoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = shadowRoot.querySelector('.ctx-ask-input');
        if (input) {
          const name = entity.companyName || entity.name || entity.ticker || '';
          const tickerStr = entity.ticker ? ` (${entity.ticker})` : '';
          input.value = `Explain ${name}${tickerStr} — what does the company do, its business model, and why it matters in this video`;
          input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
      });
    }

    const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
    // Place reaction buttons inside footer if it exists, otherwise append normally
    const footerBtns = card.querySelector('.stock-footer-buttons');
    if (footerBtns) {
      addCardButtons(card, key, entity, footerBtns);
    } else {
      addCardButtons(card, key, entity);
    }
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
    const isPrevKnown = !isRectx && (entity.previouslyKnown || entity._kbSeen);
    const seenTag = isPrevKnown ? '<span class="card-seen">\u21A9 seen before</span>' : '';

    const sourceText = entity.kbSource || entity._kbSource || '';
    const sourceLine = isPrevKnown
      ? `<div class="card-source">\u21A9 Seen in a previous session${sourceText ? ' \u2014 ' + escapeHtml(sourceText) : ''}</div>`
      : '';

    const previewDesc = entity.description ? truncateHeadline(entity.description, 60) : '';

    card.innerHTML = `
      <div class="card-row">
        ${typeBadge}
        <span class="card-term">${termText}</span>
        ${seenTag}
        <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
        <span class="card-chevron">&#x203A;</span>
        <span class="card-dismiss-inline" title="Dismiss">\u2713</span>
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

    const genericDismissKey = (entity.term || entity.name || '').toLowerCase();
    const gDismissEl = card.querySelector('.card-dismiss-inline');
    chrome.storage.local.get('dismissedEntities', (data) => {
      const dismissed = data.dismissedEntities || [];
      if (dismissed.includes(genericDismissKey)) {
        card.classList.add('card-dismissed');
        if (gDismissEl) gDismissEl.title = 'Restore';
      }
    });
    if (gDismissEl) {
      gDismissEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        card.classList.toggle('card-dismissed');
        const isDismissed = card.classList.contains('card-dismissed');
        gDismissEl.title = isDismissed ? 'Restore' : 'Dismiss';
        chrome.storage.local.get('dismissedEntities', (data) => {
          let dismissed = data.dismissedEntities || [];
          if (isDismissed) {
            if (!dismissed.includes(genericDismissKey)) dismissed.push(genericDismissKey);
          } else {
            dismissed = dismissed.filter(k => k !== genericDismissKey);
          }
          chrome.storage.local.set({ dismissedEntities: dismissed });
        });
      });
    }

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
      if (e.target.closest('.card-dismiss-inline') || e.target.closest('.card-quick-dismiss')) return;
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
              const descEl = expandArea.querySelector('.card-desc');
              if (descEl) {
                // Wrap thumbnail + description in a flex row
                const thumbRow = document.createElement('div');
                thumbRow.className = 'card-thumb-row';
                expandArea.insertBefore(thumbRow, expandArea.firstChild);
                thumbRow.appendChild(img);
                thumbRow.appendChild(descEl);
              } else {
                expandArea.insertBefore(img, expandArea.firstChild);
              }
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
        askEntityLabel = termName;
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

  function generateStudyGuide(title, history, kb, videoUrl, cardReactions, sessionQA) {
    kb = kb || {};
    cardReactions = cardReactions || {};
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

    function formatEntry(ent) {
      const term = capitalizeTerm(ent.term);
      const ts = ent.elapsedSeconds != null ? tsLink(ent.elapsedSeconds) + ' ' : '';
      return `- ${ts}**${term}**${ent.description ? ' \u2014 ' + ent.description : ''}\n`;
    }

    const insightEntries = history.filter(entry => (entry.type || '').toLowerCase() === 'insight');
    const entityEntries = history.filter(entry => (entry.type || '').toLowerCase() !== 'insight');

    // Separate starred ("New to me") entries
    const starredSet = new Set();
    for (const [term, r] of Object.entries(cardReactions)) {
      if (r.reaction === 'new') starredSet.add(term);
    }
    const starred = entityEntries.filter(e => starredSet.has((e.term || '').toLowerCase()));
    const unstarred = entityEntries.filter(e => !starredSet.has((e.term || '').toLowerCase()));

    let guide = `# Study Guide: ${title}\n`;
    if (videoUrl) guide += `${videoUrl}\n`;
    guide += '\n';

    // Highlights section first
    if (starred.length > 0) {
      guide += `## \u2B50 Highlights\n`;
      starred.forEach(ent => { guide += formatEntry(ent); });
      guide += '\n';
    }

    const TYPE_ORDER = { person: 'People', people: 'People', event: 'Events', concept: 'Concepts', place: 'Places', organization: 'Organizations', stock: 'Stocks', commodity: 'Commodities', ingredient: 'Ingredients' };
    const grouped = {};
    unstarred.forEach(entry => {
      const t = (entry.type || 'other').toLowerCase();
      const label = TYPE_ORDER[t] || (t.charAt(0).toUpperCase() + t.slice(1));
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push(entry);
    });

    const sectionOrder = ['People', 'Events', 'Concepts', 'Places', 'Organizations', 'Stocks', 'Commodities', 'Ingredients'];
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
      const ia = sectionOrder.indexOf(a), ib = sectionOrder.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    sortedKeys.forEach(label => {
      guide += `## ${label}\n`;
      grouped[label].forEach(ent => { guide += formatEntry(ent); });
      guide += '\n';
    });

    if (insightEntries.length > 0) {
      guide += `## Insights & Tips\n`;
      insightEntries.forEach(ent => {
        const ts = ent.elapsedSeconds != null ? tsLink(ent.elapsedSeconds) + ' ' : '';
        guide += `- ${ts}\u{1F4A1} **${ent.term}**${ent.description ? ' \u2014 ' + ent.description : ''}\n`;
      });
      guide += '\n';
    }

    if (sessionQA && sessionQA.length > 0) {
      guide += `## \u{1F4DD} Questions & Answers\n\n`;
      sessionQA.forEach(qa => {
        guide += `Q: What is ${qa.term}?\nA: ${qa.answer}\n\n`;
      });
    }

    guide += `---\nGenerated by Context Listener`;
    return guide;
  }

  function generateStudyGuideHTML(title, history, kb, videoUrl, cardReactions, sessionQA) {
    kb = kb || {};
    cardReactions = cardReactions || {};
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
      if (videoId) return `<a href="https://youtube.com/watch?v=${videoId}&t=${sec}" style="color:#64b5f6;text-decoration:underline;">${ts}</a>`;
      return `<span style="color:#94a3b8;">${ts}</span>`;
    }

    function typeLabel(type) {
      const t = (type || '').toLowerCase();
      const color = TYPE_COLORS[t] || '#4a4a6a';
      const label = t.toUpperCase();
      return label ? `<span style="color:${color};font-size:11px;font-weight:600;">${label}</span> ` : '';
    }

    function formatEntry(ent) {
      const term = escapeHtml(capitalizeTerm(ent.term));
      const ts = ent.elapsedSeconds != null ? tsLink(ent.elapsedSeconds) + ' ' : '';
      const desc = ent.description ? ' \u2014 ' + escapeHtml(ent.description) : '';
      return `<li>${ts}${typeLabel(ent.type)}<strong>${term}</strong>${desc}</li>`;
    }

    const insightEntries = history.filter(entry => (entry.type || '').toLowerCase() === 'insight');
    const entityEntries = history.filter(entry => (entry.type || '').toLowerCase() !== 'insight');

    const starredSet = new Set();
    for (const [term, r] of Object.entries(cardReactions)) {
      if (r.reaction === 'new') starredSet.add(term);
    }
    const starred = entityEntries.filter(e => starredSet.has((e.term || '').toLowerCase()));
    const unstarred = entityEntries.filter(e => !starredSet.has((e.term || '').toLowerCase()));

    let html = `<h1 style="margin:0 0 4px 0;font-size:18px;">Study Guide: ${escapeHtml(title)}</h1>`;
    if (videoUrl) html += `<p style="margin:0 0 12px 0;"><a href="${escapeHtml(videoUrl)}" style="color:#64b5f6;">${escapeHtml(videoUrl)}</a></p>`;

    if (starred.length > 0) {
      html += `<h2 style="color:#eab308;font-size:15px;margin:16px 0 6px 0;">\u2B50 Highlights</h2><ul style="margin:0 0 8px 0;padding-left:20px;">`;
      starred.forEach(ent => { html += formatEntry(ent); });
      html += '</ul>';
    }

    const TYPE_ORDER = { person: 'People', people: 'People', event: 'Events', concept: 'Concepts', place: 'Places', organization: 'Organizations', stock: 'Stocks', commodity: 'Commodities', ingredient: 'Ingredients' };
    const grouped = {};
    unstarred.forEach(entry => {
      const t = (entry.type || 'other').toLowerCase();
      const label = TYPE_ORDER[t] || (t.charAt(0).toUpperCase() + t.slice(1));
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push(entry);
    });

    const sectionOrder = ['People', 'Events', 'Concepts', 'Places', 'Organizations', 'Stocks', 'Commodities', 'Ingredients'];
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
      const ia = sectionOrder.indexOf(a), ib = sectionOrder.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    sortedKeys.forEach(label => {
      html += `<h2 style="font-size:15px;margin:16px 0 6px 0;">${escapeHtml(label)}</h2><ul style="margin:0 0 8px 0;padding-left:20px;">`;
      grouped[label].forEach(ent => { html += formatEntry(ent); });
      html += '</ul>';
    });

    if (insightEntries.length > 0) {
      html += `<h2 style="font-size:15px;margin:16px 0 6px 0;">Insights &amp; Tips</h2><ul style="margin:0 0 8px 0;padding-left:20px;">`;
      insightEntries.forEach(ent => {
        const ts = ent.elapsedSeconds != null ? tsLink(ent.elapsedSeconds) + ' ' : '';
        const desc = ent.description ? ' \u2014 ' + escapeHtml(ent.description) : '';
        html += `<li>${ts}\u{1F4A1} <strong>${escapeHtml(capitalizeTerm(ent.term))}</strong>${desc}</li>`;
      });
      html += '</ul>';
    }

    if (sessionQA && sessionQA.length > 0) {
      html += `<h2 style="font-size:15px;margin:16px 0 6px 0;">\u{1F4DD} Questions &amp; Answers</h2>`;
      sessionQA.forEach(qa => {
        html += `<div style="margin-bottom:10px;"><p style="margin:0 0 2px 0;"><strong>Q: What is ${escapeHtml(qa.term)}?</strong></p><p style="margin:0;">A: ${escapeHtml(qa.answer)}</p></div>`;
      });
    }

    html += `<hr style="border:none;border-top:1px solid #ccc;margin:16px 0 8px 0;"><p style="margin:0;font-size:12px;color:#888;">Generated by Context Listener</p>`;
    return html;
  }

  function ensureSidebar() {
    if (shadowRoot) return shadowRoot.getElementById('cards');

    if (!document.body) {
      let retries = 0;
      const waitForBody = setInterval(() => {
        retries++;
        if (document.body) {
          clearInterval(waitForBody);
          ensureSidebar();
        } else if (retries > 30) {
          clearInterval(waitForBody);
          console.warn('[CONTENT] document.body not available after 3s, sidebar creation aborted');
        }
      }, 100);
      return null;
    }

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
      <div class="ctx-header-row1">
        <div class="ctx-header-row1-left">
          <span class="ctx-wordmark">context</span>
          <div class="ctx-live">
            <span class="ctx-live-dot"></span>
            <span class="ctx-live-text">Live</span>
          </div>
        </div>
        <div class="ctx-header-row1-right">
          <button id="ctx-listen-btn" title="Start Listening">&#x25B6;</button>
          <button class="ctx-close-btn" title="Close sidebar">&times;</button>
        </div>
      </div>
      <div class="ctx-header-row2">
        <button class="ctx-clear-btn ctx-toolbar-btn" title="Clear session">CLEAR</button>
        <div class="ctx-export-wrap" style="position:relative;"><button class="ctx-export-btn ctx-toolbar-btn" title="Export study guide">EXPORT<span class="ctx-export-tooltip">Copied!</span></button><div class="ctx-export-menu"><button class="ctx-export-menu-item" data-action="clipboard">Copy to clipboard</button><button class="ctx-export-menu-item" data-action="gmail">Open in Gmail</button><button class="ctx-export-menu-item" data-action="download">Download as .txt</button></div></div>
        <button class="ctx-history-btn ctx-toolbar-btn" title="Session history">HISTORY</button>
        <button class="ctx-settings-btn ctx-toolbar-btn" title="Settings">SETTINGS</button>
      </div>
    `;

    // Wire up listen button
    // Wire up close button
    header.querySelector('.ctx-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeSidebar();
    });

    const listenBtn = header.querySelector('#ctx-listen-btn');
    listenBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' });
    });

    // Sync listen button state on sidebar open
    chrome.storage.local.get('capturing', (data) => {
      if (data.capturing) {
        listenBtn.textContent = '\u25A0'; listenBtn.title = 'Stop Recording';
        listenBtn.classList.add('listening');
      }
    });

    // Wire up clear button with inline confirmation
    const clearBtn = header.querySelector('.ctx-clear-btn');
    const headerRow2 = header.querySelector('.ctx-header-row2');
    let clearTimer = null;
    clearBtn.addEventListener('click', () => {
      if (clearBtn.dataset.confirming === 'true') return;
      clearBtn.dataset.confirming = 'true';
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
      headerRow2.appendChild(confirm);
      function revert() {
        if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
        confirm.remove();
        clearBtn.dataset.confirming = 'false';
      }
      yesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        resetSidebar();
        chrome.storage.local.remove(['sessionHistory', 'sessionTranscript', 'pendingEntities', 'pendingInsights']);
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
      chrome.storage.local.get(['sessionHistory', 'capturingTabTitle', 'knowledgeBase', 'activeTabUrl', 'cardReactions', 'sessionQA'], (data) => {
        const history = data.sessionHistory || [];
        const title = data.capturingTabTitle || document.title || 'Untitled';
        const url = data.activeTabUrl || window.location.href;
        const kb = data.knowledgeBase || {};
        const reactions = data.cardReactions || {};
        const qa = data.sessionQA || [];
        const guide = generateStudyGuide(title, history, kb, url, reactions, qa);
        const guideHtml = generateStudyGuideHTML(title, history, kb, url, reactions, qa);
        callback({ guide, guideHtml, title });
      });
    }

    exportMenu.querySelector('[data-action="clipboard"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      getStudyGuideData(({ guide, guideHtml }) => {
        copyRichToClipboard(guideHtml, guide).then(() => {
          const tooltip = header.querySelector('.ctx-export-tooltip');
          tooltip.classList.add('visible');
          setTimeout(() => tooltip.classList.remove('visible'), 1500);
        });
      });
    });

    exportMenu.querySelector('[data-action="gmail"]').addEventListener('click', (e) => {
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      getStudyGuideData(({ guide, guideHtml, title }) => {
        copyRichToClipboard(guideHtml, guide).then(() => {
          const tooltip = header.querySelector('.ctx-export-tooltip');
          tooltip.textContent = 'Study guide copied \u2014 paste into your email';
          tooltip.classList.add('visible');
          setTimeout(() => { tooltip.classList.remove('visible'); tooltip.textContent = 'Copied!'; }, 3000);
          const gmailUrl = 'https://mail.google.com/mail/?view=cm&fs=1&su=' +
            encodeURIComponent(title);
          window.open(gmailUrl, '_blank');
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
      <div id="kb-matches-wrapper">
        <div class="kb-matches-toggle">\u25BE You've explored related topics before</div>
        <div id="empty-kb-matches"></div>
      </div>
    `;

    // KB matches toggle header
    const kbToggle = emptyState.querySelector('.kb-matches-toggle');
    kbToggle.addEventListener('click', () => {
      const wrapper = shadowRoot.getElementById('kb-matches-wrapper');
      if (wrapper) {
        wrapper.classList.toggle('collapsed');
        kbToggle.textContent = wrapper.classList.contains('collapsed')
          ? '\u25B8 You\'ve explored related topics before'
          : '\u25BE You\'ve explored related topics before';
      }
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
          const wrapper = emptyState.querySelector('#kb-matches-wrapper');
          if (wrapper) wrapper.classList.add('visible');
        } else {
          matchContainer.innerHTML = '<div style="font-size:12px;color:#64748b;">Terms, people, and concepts will appear here as they\'re mentioned.</div>';
        }
      } else {
        matchContainer.innerHTML = '<div style="font-size:12px;color:#64748b;">Terms, people, and concepts will appear here as they\'re mentioned.</div>';
      }
    });

    // View tabs (Cards / Transcript)
    const viewTabs = document.createElement('div');
    viewTabs.className = 'ctx-view-tabs';
    const cardsTab = document.createElement('button');
    cardsTab.className = 'ctx-view-tab active';
    cardsTab.textContent = 'Cards';
    const transcriptTab = document.createElement('button');
    transcriptTab.className = 'ctx-view-tab';
    transcriptTab.textContent = 'Transcript';
    viewTabs.appendChild(cardsTab);
    viewTabs.appendChild(transcriptTab);

    let activeView = 'cards';
    function switchView(view) {
      activeView = view;
      cardsTab.classList.toggle('active', view === 'cards');
      transcriptTab.classList.toggle('active', view === 'transcript');
      cardsWrap.classList.toggle('hidden', view !== 'cards');
      transcriptView.classList.toggle('active', view === 'transcript');
    }
    cardsTab.addEventListener('click', () => switchView('cards'));
    transcriptTab.addEventListener('click', () => switchView('transcript'));

    function addToNotes() { /* no-op — Notes tab removed */ }

    // Listening indicator
    const listeningIndicator = document.createElement('div');
    listeningIndicator.id = 'listening-indicator';
    listeningIndicator.innerHTML = '<span class="li-dot"></span><span class="li-text">Listening for new terms...</span>';

    // Error status bar
    const statusBar = document.createElement('div');
    statusBar.className = 'ctx-status-bar';
    statusBar.id = 'ctx-status-bar';
    statusBar.innerHTML = '<span class="ctx-status-icon"></span><span class="ctx-status-text"></span>';

    // Cards container
    const cardContainer = document.createElement('div');
    cardContainer.id = 'cards';

    // Ask response area
    const askResponse = document.createElement('div');
    askResponse.className = 'ctx-ask-response';

    let askEntityLabel = '';

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
        const headerText = askEntityLabel || question;
        askEntityLabel = '';
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
            askResponse.textContent = '';
            const headerDiv = document.createElement('div');
            headerDiv.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:6px;color:#e0e0e0;';
            headerDiv.textContent = 'About: ' + headerText;
            askResponse.appendChild(headerDiv);
            const answerStr = result.answer || 'No answer available';
            const answerText = document.createTextNode(answerStr);
            askResponse.appendChild(answerText);
            askResponse.appendChild(askClear);
            // Save Q&A to persistent storage
            chrome.storage.local.get('sessionQA', (qaData) => {
              const qa = qaData.sessionQA || [];
              qa.push({ term: headerText, question, answer: answerStr, timestamp: Date.now(), videoTitle: data.capturingTabTitle || document.title || '' });
              chrome.storage.local.set({ sessionQA: qa });
            });
          })
          .catch(() => {
            askResponse.classList.remove('ctx-ask-loading');
            askResponse.textContent = '';
            const headerDiv = document.createElement('div');
            headerDiv.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:6px;color:#e0e0e0;';
            headerDiv.textContent = 'About: ' + headerText;
            askResponse.appendChild(headerDiv);
            const answerText = document.createTextNode('Could not get an answer');
            askResponse.appendChild(answerText);
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
    sidebar.appendChild(viewTabs);

    // Cards wrap — contains all cards-view elements
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'ctx-cards-wrap';
    cardsWrap.appendChild(listeningIndicator);
    cardsWrap.appendChild(statusBar);
    cardsWrap.appendChild(emptyState);

    // Pinned "Now Watching" bar
    const nowWatchingBar = document.createElement('div');
    nowWatchingBar.id = 'ctx-now-watching';
    nowWatchingBar.className = 'ctx-now-watching';
    nowWatchingBar.style.display = 'none';
    nowWatchingBar.innerHTML = `<span class="ctx-now-watching-label">NOW WATCHING</span><span class="ctx-now-watching-title"></span>`;
    cardsWrap.appendChild(nowWatchingBar);

    // Filter bar
    const filterBar = document.createElement('div');
    filterBar.className = 'ctx-filter-bar';
    const hideKnownBtn = document.createElement('button');
    hideKnownBtn.className = 'ctx-filter-btn';
    hideKnownBtn.textContent = 'Hide known';
    const starredOnlyBtn = document.createElement('button');
    starredOnlyBtn.className = 'ctx-filter-btn';
    starredOnlyBtn.textContent = '\u2605 only';
    hideKnownBtn.addEventListener('click', () => {
      hideKnownBtn.classList.toggle('active');
      cardContainer.classList.toggle('filter-hide-known');
      if (virtualActive) { virtualRenderedRange = { start: -1, end: -1 }; virtualScrollRender(cardContainer); }
    });
    starredOnlyBtn.addEventListener('click', () => {
      starredOnlyBtn.classList.toggle('active');
      cardContainer.classList.toggle('filter-starred-only');
      if (virtualActive) { virtualRenderedRange = { start: -1, end: -1 }; virtualScrollRender(cardContainer); }
    });
    const collapseAllBtn = document.createElement('button');
    collapseAllBtn.className = 'ctx-filter-btn';
    collapseAllBtn.textContent = '\u25B2 Collapse';
    let allCollapsed = false;
    collapseAllBtn.addEventListener('click', () => {
      allCollapsed = !allCollapsed;
      collapseAllBtn.classList.toggle('active', allCollapsed);
      collapseAllBtn.textContent = allCollapsed ? '\u25BC Expand' : '\u25B2 Collapse';
      const entityCards = cardContainer.querySelectorAll('.context-card:not(.insight-card)');
      if (allCollapsed) {
        // Collapse all: remove expanded from all entity cards, use CSS collapse
        allowMultipleExpand = false;
        entityCards.forEach(c => c.classList.remove('expanded'));
        currentlyExpandedCard = null;
        cardContainer.classList.add('collapse-all');
      } else {
        // Expand all: add expanded to all entity cards, allow multiple
        allowMultipleExpand = true;
        cardContainer.classList.remove('collapse-all');
        entityCards.forEach(c => c.classList.add('expanded'));
      }
    });
    filterBar.appendChild(hideKnownBtn);
    filterBar.appendChild(starredOnlyBtn);
    filterBar.appendChild(collapseAllBtn);
    cardsWrap.appendChild(filterBar);

    cardsWrap.appendChild(cardContainer);
    cardsWrap.appendChild(askResponse);
    cardsWrap.appendChild(suggestionsBar);
    cardsWrap.appendChild(askBar);
    sidebar.appendChild(cardsWrap);

    // ─── Transcript view ───
    const transcriptView = document.createElement('div');
    transcriptView.className = 'ctx-transcript-view';
    const transcriptScroll = document.createElement('div');
    transcriptScroll.className = 'ctx-transcript-scroll';
    transcriptScroll.innerHTML = '<div class="ctx-transcript-empty">Transcript will appear here when audio is captured.</div>';
    transcriptAutoScroll = true;
    transcriptScroll.addEventListener('scroll', () => {
      const atBottom = transcriptScroll.scrollHeight - transcriptScroll.scrollTop - transcriptScroll.clientHeight < 40;
      transcriptAutoScroll = atBottom;
    });
    const transcriptFooter = document.createElement('div');
    transcriptFooter.className = 'ctx-transcript-footer';
    const transcriptCopyBtn = document.createElement('button');
    transcriptCopyBtn.className = 'ctx-transcript-copy';
    transcriptCopyBtn.textContent = 'Copy transcript';
    transcriptCopyBtn.addEventListener('click', () => {
      const chunks = transcriptScroll.querySelectorAll('.ctx-transcript-text');
      const plain = Array.from(chunks).map(el => el.textContent).join(' ');
      copyToClipboard(plain).then(() => {
        transcriptCopyBtn.textContent = 'Copied!';
        setTimeout(() => { transcriptCopyBtn.textContent = 'Copy transcript'; }, 1500);
      });
    });
    transcriptFooter.appendChild(transcriptCopyBtn);
    transcriptView.appendChild(transcriptScroll);
    transcriptView.appendChild(transcriptFooter);
    sidebar.appendChild(transcriptView);

    // ─── Settings panel ───
    const ALL_INTERESTS = ['Finance & Economics', 'History & Culture', 'Politics & Law', 'Science & Technology', 'Business & Markets', 'Arts & Society', 'Sports', 'Cooking & Food'];
    const settingsPanel = document.createElement('div');
    settingsPanel.className = 'ctx-settings-panel';
    let userSettings = { knowledgeLevel: 'intermediate', interests: [...ALL_INTERESTS], autoOpen: true, showInsights: true };

    function buildSettingsPanel() {
      settingsPanel.innerHTML = '';

      const heading = document.createElement('div');
      heading.className = 'ctx-settings-heading';
      heading.textContent = 'Settings';
      settingsPanel.appendChild(heading);

      // Section 1: Knowledge Level
      const s1 = document.createElement('div');
      s1.className = 'ctx-settings-section';
      const s1Label = document.createElement('div');
      s1Label.className = 'ctx-settings-label';
      s1Label.textContent = 'Your knowledge level';
      s1.appendChild(s1Label);
      const radios = document.createElement('div');
      radios.className = 'ctx-settings-radios';
      ['beginner', 'intermediate', 'expert'].forEach(level => {
        const btn = document.createElement('button');
        btn.className = 'ctx-settings-radio' + (userSettings.knowledgeLevel === level ? ' active' : '');
        btn.textContent = level.charAt(0).toUpperCase() + level.slice(1);
        btn.addEventListener('click', () => {
          userSettings.knowledgeLevel = level;
          radios.querySelectorAll('.ctx-settings-radio').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          saveUserSettings();
        });
        radios.appendChild(btn);
      });
      s1.appendChild(radios);
      settingsPanel.appendChild(s1);

      // Section 2: Interests
      const s2 = document.createElement('div');
      s2.className = 'ctx-settings-section';
      const s2Label = document.createElement('div');
      s2Label.className = 'ctx-settings-label';
      s2Label.textContent = 'Topics you care about';
      s2.appendChild(s2Label);
      const chips = document.createElement('div');
      chips.className = 'ctx-settings-chips';
      ALL_INTERESTS.forEach(topic => {
        const chip = document.createElement('button');
        chip.className = 'ctx-settings-chip' + (userSettings.interests.includes(topic) ? ' active' : '');
        chip.textContent = topic;
        chip.addEventListener('click', () => {
          if (userSettings.interests.includes(topic)) {
            userSettings.interests = userSettings.interests.filter(t => t !== topic);
            chip.classList.remove('active');
          } else {
            userSettings.interests.push(topic);
            chip.classList.add('active');
          }
          saveUserSettings();
        });
        chips.appendChild(chip);
      });
      s2.appendChild(chips);
      settingsPanel.appendChild(s2);

      // Section 3: Display
      const s3 = document.createElement('div');
      s3.className = 'ctx-settings-section';
      const s3Label = document.createElement('div');
      s3Label.className = 'ctx-settings-label';
      s3Label.textContent = 'Display';
      s3.appendChild(s3Label);

      function addToggle(label, key) {
        const row = document.createElement('div');
        row.className = 'ctx-settings-toggle-row';
        const lbl = document.createElement('span');
        lbl.className = 'ctx-settings-toggle-label';
        lbl.textContent = label;
        const toggle = document.createElement('button');
        toggle.className = 'ctx-settings-toggle' + (userSettings[key] ? ' on' : '');
        toggle.addEventListener('click', () => {
          userSettings[key] = !userSettings[key];
          toggle.classList.toggle('on', userSettings[key]);
          saveUserSettings();
          if (key === 'showInsights') {
            cardContainer.classList.toggle('hide-insights', !userSettings.showInsights);
          }
        });
        row.appendChild(lbl);
        row.appendChild(toggle);
        s3.appendChild(row);
      }
      addToggle('Auto-open sidebar on capture start', 'autoOpen');
      addToggle('Show insights', 'showInsights');
      settingsPanel.appendChild(s3);

      // Done button
      const done = document.createElement('button');
      done.className = 'ctx-settings-done';
      done.textContent = 'Done';
      done.addEventListener('click', () => {
        settingsPanel.classList.remove('open');
        settingsBtn.classList.remove('active');
      });
      settingsPanel.appendChild(done);
    }

    function saveUserSettings() {
      chrome.storage.local.set({ userSettings });
    }

    // Load saved settings
    chrome.storage.local.get('userSettings', (data) => {
      if (data.userSettings) {
        userSettings = { ...userSettings, ...data.userSettings };
      }
      // Apply showInsights immediately
      if (!userSettings.showInsights) {
        cardContainer.classList.add('hide-insights');
      }
      buildSettingsPanel();
    });

    sidebar.appendChild(settingsPanel);

    // Wire up gear button
    const settingsBtn = header.querySelector('.ctx-settings-btn');
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = settingsPanel.classList.contains('open');
      if (isOpen) {
        settingsPanel.classList.remove('open');
        settingsBtn.classList.remove('active');
      } else {
        // Close history panel if open
        historyPanel.classList.remove('open');
        historyBtn.classList.remove('active');
        buildSettingsPanel();
        settingsPanel.classList.add('open');
        settingsBtn.classList.add('active');
      }
    });

    // ─── History panel ───
    const historyPanel = document.createElement('div');
    historyPanel.className = 'ctx-history-panel';

    function formatSessionDate(isoStr) {
      const d = new Date(isoStr);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    function buildHistoryPanel() {
      historyPanel.innerHTML = '';

      const hdr = document.createElement('div');
      hdr.className = 'ctx-history-header';
      const backBtn = document.createElement('button');
      backBtn.className = 'ctx-history-back';
      backBtn.textContent = '\u2190 Back';
      backBtn.addEventListener('click', () => {
        historyPanel.classList.remove('open');
        historyBtn.classList.remove('active');
      });
      const hTitle = document.createElement('span');
      hTitle.className = 'ctx-history-title';
      hTitle.textContent = 'Session History';
      hdr.appendChild(backBtn);
      hdr.appendChild(hTitle);
      historyPanel.appendChild(hdr);

      const list = document.createElement('div');
      list.className = 'ctx-history-list';
      historyPanel.appendChild(list);

      chrome.storage.local.get('pastSessions', (data) => {
        const sessions = data.pastSessions || [];
        if (sessions.length === 0) {
          list.innerHTML = '<div class="ctx-history-empty">No past sessions yet.<br>Sessions are saved when you clear the sidebar.</div>';
        } else {
          sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = 'ctx-history-item';

            const chevron = document.createElement('span');
            chevron.className = 'ctx-history-item-chevron';
            chevron.textContent = '\u203A';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'ctx-history-item-title';
            titleDiv.textContent = session.title || 'Untitled';
            titleDiv.appendChild(chevron);

            const meta = document.createElement('div');
            meta.className = 'ctx-history-item-meta';
            const dateSpan = document.createElement('span');
            dateSpan.textContent = formatSessionDate(session.date);
            const badge = document.createElement('span');
            badge.className = 'ctx-history-item-badge';
            badge.textContent = (session.entityCount || 0) + ' entities';
            meta.appendChild(dateSpan);
            meta.appendChild(badge);

            const detail = document.createElement('div');
            detail.className = 'ctx-history-item-detail';

            item.appendChild(titleDiv);
            item.appendChild(meta);
            item.appendChild(detail);

            item.addEventListener('click', () => {
              const wasExpanded = item.classList.contains('expanded');
              // Collapse any other expanded items
              list.querySelectorAll('.ctx-history-item.expanded').forEach(el => {
                el.classList.remove('expanded');
                el.querySelector('.ctx-history-item-detail').innerHTML = '';
              });
              if (!wasExpanded) {
                item.classList.add('expanded');
                renderSessionDetail(detail, session);
              }
            });

            list.appendChild(item);
          });
        }
      });

      // Clear history footer
      const footer = document.createElement('div');
      footer.className = 'ctx-history-clear';
      const clearLink = document.createElement('button');
      clearLink.className = 'ctx-history-clear-link';
      clearLink.textContent = 'Clear History';
      clearLink.addEventListener('click', (e) => {
        e.stopPropagation();
        if (clearLink.dataset.confirming === 'true') return;
        clearLink.dataset.confirming = 'true';
        clearLink.textContent = 'Delete all past sessions? ';
        const yesBtn = document.createElement('button');
        yesBtn.className = 'ctx-history-clear-link';
        yesBtn.textContent = 'Yes';
        yesBtn.style.cssText = 'margin-left:6px;text-decoration:underline;';
        const noBtn = document.createElement('button');
        noBtn.className = 'ctx-history-clear-link';
        noBtn.textContent = 'No';
        noBtn.style.cssText = 'margin-left:6px;color:#94a3b8;text-decoration:underline;';
        clearLink.appendChild(yesBtn);
        clearLink.appendChild(noBtn);
        function revert() {
          clearLink.textContent = 'Clear History';
          clearLink.dataset.confirming = 'false';
        }
        yesBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          chrome.storage.local.remove('pastSessions');
          list.innerHTML = '<div class="ctx-history-empty">No past sessions yet.<br>Sessions are saved when you clear the sidebar.</div>';
          revert();
        });
        noBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          revert();
        });
        setTimeout(revert, 4000);
      });
      footer.appendChild(clearLink);
      historyPanel.appendChild(footer);
    }

    function renderSessionDetail(container, session) {
      container.innerHTML = '';
      const entities = session.entities || [];
      const insights = session.insights || [];

      if (entities.length > 0) {
        entities.forEach(ent => {
          const el = document.createElement('div');
          el.className = 'ctx-history-entity';
          const termSpan = document.createElement('span');
          termSpan.className = 'ctx-history-entity-term';
          termSpan.textContent = ent.term || '';
          el.appendChild(termSpan);
          if (ent.type && ent.type !== 'insight') {
            const typeSpan = document.createElement('span');
            typeSpan.className = 'ctx-history-entity-type';
            typeSpan.textContent = ent.type;
            typeSpan.style.cssText = 'color:' + getTypeColor(ent.type) + ';background:' + getTypeColor(ent.type) + '15;';
            el.appendChild(typeSpan);
          }
          if (ent.description) {
            const desc = document.createElement('div');
            desc.className = 'ctx-history-entity-desc';
            desc.textContent = ent.description;
            el.appendChild(desc);
          }
          container.appendChild(el);
        });
      }

      if (insights.length > 0) {
        insights.forEach(ins => {
          const el = document.createElement('div');
          el.className = 'ctx-history-insight';
          const text = document.createElement('div');
          text.className = 'ctx-history-insight-text';
          text.textContent = ins.term || ins.insight || '';
          el.appendChild(text);
          if (ins.description || ins.detail) {
            const det = document.createElement('div');
            det.className = 'ctx-history-insight-detail';
            det.textContent = ins.description || ins.detail;
            el.appendChild(det);
          }
          container.appendChild(el);
        });
      }

      if (entities.length === 0 && insights.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:#64748b;padding:8px 0;">No entities saved for this session.</div>';
      }
    }

    sidebar.appendChild(historyPanel);

    // Wire up history button
    const historyBtn = header.querySelector('.ctx-history-btn');
    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = historyPanel.classList.contains('open');
      if (isOpen) {
        historyPanel.classList.remove('open');
        historyBtn.classList.remove('active');
      } else {
        // Close settings panel if open
        settingsPanel.classList.remove('open');
        settingsBtn.classList.remove('active');
        buildHistoryPanel();
        historyPanel.classList.add('open');
        historyBtn.classList.add('active');
      }
    });

    shadowRoot.appendChild(sidebar);
    document.body.appendChild(hostEl);

    ensureBadge();
    applyTheme();
    console.log('[CONTENT] Shadow DOM sidebar created');

    // Recover cards and sidebar state from storage (e.g. page refresh)
    chrome.storage.local.get(['sessionHistory', 'capturing', 'sidebarOpen', 'activeTabUrl'], (data) => {
      const history = data.sessionHistory || [];
      const cards = shadowRoot.getElementById('cards');
      if (history.length > 0 && cards && cards.children.length === 0) {
        console.log('[CONTENT] Recovering', history.length, 'cards from storage');
        const emptyState = shadowRoot.getElementById('empty-state');
        if (emptyState) emptyState.style.display = 'none';
        cards.style.display = 'block';
        hasCards = true;

        // Build virtualCards array from history
        resetVirtualScroll();
        history.forEach(item => {
          try {
            let vcType = 'entity';
            if (item.type === 'video-divider') vcType = 'divider';
            else if (item.type === 'insight' && item.category) vcType = 'insight';
            else if (item.type === 'stock') vcType = 'stock';

            const vcData = vcType === 'insight'
              ? { insight: item.term, category: item.category, detail: item.description, timestamp: item.timestamp }
              : item;

            virtualCards.push({
              data: vcData,
              height: vcType === 'insight' ? HEIGHT_INSIGHT : (vcType === 'divider' ? HEIGHT_DIVIDER : HEIGHT_COLLAPSED),
              measuredHeight: 0,
              type: vcType,
              el: null,
              dismissed: false,
              highlighted: false
            });
          } catch (e) {
            console.log('[CONTENT] Failed to recover card:', item.term, e.message);
          }
        });

        // Render: use virtual scrolling if > threshold, otherwise render all
        if (virtualCards.length > VIRTUAL_THRESHOLD) {
          activateVirtualScroll(cards);
        } else {
          virtualCards.forEach(vc => {
            const el = createVirtualCardElement(vc);
            vc.el = el;
            cards.appendChild(el);
          });
        }
        termCount = virtualCards.filter(vc => vc.type !== 'divider').length;

        // Update badge count
        const badge = shadowRoot.querySelector('.ctx-badge-count') || (badgeShadow && badgeShadow.querySelector('.ctx-badge-count'));
        if (badge) badge.textContent = String(termCount);

        console.log('[CONTENT] Recovered', virtualCards.length, 'cards' + (virtualActive ? ' (virtual scroll)' : ''));
      }

      // Sync button state if currently capturing
      if (data.capturing) {
        const btn = shadowRoot.getElementById('ctx-listen-btn');
        if (btn) {
          btn.textContent = '\u25A0'; btn.title = 'Stop Recording';
          btn.classList.add('listening');
        }
      }

      // Auto-reopen sidebar only on the capturing tab
      const isCapturingTab = (() => {
        try {
          if (!data.activeTabUrl) return false;
          const active = new URL(data.activeTabUrl);
          const current = new URL(window.location.href);
          return active.origin + active.pathname === current.origin + current.pathname;
        } catch (e) {
          return data.activeTabUrl === window.location.href;
        }
      })();

      if (isCapturingTab && (data.sidebarOpen || data.capturing)) {
        hostEl.dataset.open = 'true';
        hostEl.style.width = '280px';
        hostEl.style.pointerEvents = 'auto';
        const sb = shadowRoot.getElementById('sidebar');
        if (sb) {
          sb.dataset.pos = settings.sidebarPosition || 'right';
          sb.classList.add('open');
        }
        console.log('[CONTENT] Auto-reopened sidebar after refresh (capturing tab)');
      }
    });

    // Restore Now Watching bar on page refresh — read document.title directly
    chrome.storage.local.get('capturing', (data) => {
      if (data.capturing) {
        const bar = shadowRoot?.getElementById('ctx-now-watching');
        if (bar) {
          const title = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
          if (title && title !== 'YouTube') {
            bar.querySelector('.ctx-now-watching-title').textContent = title;
            bar.style.display = 'flex';
          }
        }
      }
    });

    // Watch for title changes to keep Now Watching bar current (YouTube SPA updates title dynamically)
    const titleObserver = new MutationObserver(() => {
      const bar = shadowRoot?.getElementById('ctx-now-watching');
      if (bar && bar.style.display !== 'none') {
        const title = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
        if (title && title !== 'YouTube') {
          bar.querySelector('.ctx-now-watching-title').textContent = title;
        }
      }
    });
    const titleEl = document.querySelector('title');
    if (titleEl) {
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

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
    resetVirtualScroll();
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

  // ─── Virtual scrolling engine ───

  function estimateCardHeight(vcard) {
    if (vcard.measuredHeight) return vcard.measuredHeight;
    if (vcard.type === 'divider') return HEIGHT_DIVIDER;
    if (vcard.type === 'insight') return HEIGHT_INSIGHT;
    return HEIGHT_COLLAPSED;
  }

  function isCardFiltered(vcard, cardsEl) {
    if (!cardsEl) return false;
    // Sync filter state from DOM element if it exists
    if (vcard.el) {
      vcard.dismissed = vcard.el.classList.contains('card-dismissed');
      vcard.highlighted = vcard.el.classList.contains('card-highlighted');
    }
    if (cardsEl.classList.contains('filter-hide-known') && vcard.dismissed) return true;
    if (cardsEl.classList.contains('filter-starred-only') && !vcard.highlighted) return true;
    if (cardsEl.classList.contains('hide-insights') && vcard.type === 'insight') return true;
    return false;
  }

  function getVisibleVirtualCards(cardsEl) {
    return virtualCards.filter(vc => !isCardFiltered(vc, cardsEl));
  }

  function getTotalVirtualHeight(cardsEl) {
    let h = 0;
    for (const vc of virtualCards) {
      if (!isCardFiltered(vc, cardsEl)) h += estimateCardHeight(vc);
    }
    return h;
  }

  function virtualScrollRender(cardsEl) {
    if (!virtualActive || !cardsEl) return;
    const visible = getVisibleVirtualCards(cardsEl);
    const totalHeight = getTotalVirtualHeight(cardsEl);

    let topSpacer = cardsEl.querySelector('.ctx-virtual-spacer-top');
    let bottomSpacer = cardsEl.querySelector('.ctx-virtual-spacer-bottom');
    if (!topSpacer) {
      topSpacer = document.createElement('div');
      topSpacer.className = 'ctx-virtual-spacer-top';
      cardsEl.prepend(topSpacer);
    }
    if (!bottomSpacer) {
      bottomSpacer = document.createElement('div');
      bottomSpacer.className = 'ctx-virtual-spacer-bottom';
      cardsEl.appendChild(bottomSpacer);
    }

    const scrollTop = cardsEl.scrollTop;
    const viewHeight = cardsEl.clientHeight;

    // Find which visible cards are in the viewport
    let accum = 0;
    let startIdx = -1, endIdx = -1;
    for (let i = 0; i < visible.length; i++) {
      const h = estimateCardHeight(visible[i]);
      if (startIdx === -1 && accum + h > scrollTop) {
        startIdx = i;
      }
      if (accum > scrollTop + viewHeight) {
        endIdx = i;
        break;
      }
      accum += h;
    }
    if (startIdx === -1) startIdx = 0;
    if (endIdx === -1) endIdx = visible.length;

    // Add buffer
    startIdx = Math.max(0, startIdx - VIRTUAL_BUFFER);
    endIdx = Math.min(visible.length, endIdx + VIRTUAL_BUFFER);

    // Check if range changed
    if (startIdx === virtualRenderedRange.start && endIdx === virtualRenderedRange.end) return;
    virtualRenderedRange = { start: startIdx, end: endIdx };

    // Calculate spacer heights
    let topH = 0;
    for (let i = 0; i < startIdx; i++) topH += estimateCardHeight(visible[i]);
    let bottomH = 0;
    for (let i = endIdx; i < visible.length; i++) bottomH += estimateCardHeight(visible[i]);

    // Remove all card elements (keep spacers)
    const existingCards = cardsEl.querySelectorAll('.context-card, .ctx-video-divider');
    existingCards.forEach(el => el.remove());

    topSpacer.style.height = topH + 'px';
    bottomSpacer.style.height = bottomH + 'px';

    // Render visible range
    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      const vc = visible[i];
      let el = vc.el;
      if (!el) {
        el = createVirtualCardElement(vc);
        vc.el = el;
      }
      frag.appendChild(el);
      // Measure after first render
      if (!vc.measuredHeight && el.offsetHeight > 0) {
        vc.measuredHeight = el.offsetHeight;
      }
    }
    // Insert after top spacer
    topSpacer.after(frag);

    // Measure any newly rendered cards
    requestAnimationFrame(() => {
      for (let i = startIdx; i < endIdx; i++) {
        const vc = visible[i];
        if (vc.el && vc.el.offsetHeight > 0) {
          vc.measuredHeight = vc.el.offsetHeight;
        }
      }
    });
  }

  function createVirtualCardElement(vc) {
    if (vc.type === 'divider') {
      const divider = document.createElement('div');
      divider.className = 'ctx-video-divider';
      const displayTitle = escapeHtml(
        (vc.data.term || 'Previous video')
          .replace(/\s*-\s*YouTube$/i, '')
          .replace(/^\(\d+\)\s*/, '')
          .trim()
      ) || 'Previous video';
      const prevUrl = vc.data.url || '';
      const link = prevUrl
        ? `<a href="${escapeHtml(prevUrl)}" target="_blank" class="ctx-divider-link">${displayTitle}</a>`
        : `<span class="ctx-divider-link">${displayTitle}</span>`;
      divider.innerHTML = `<div class="ctx-divider-prev"><span class="ctx-divider-label">PREVIOUS</span>${link}</div><div class="ctx-divider-line-full"></div>`;
      return divider;
    }
    if (vc.type === 'insight') {
      const card = createInsightCard(vc.data);
      card.dataset.createdAt = (vc.data.timestamp || Date.now()).toString();
      return card;
    }
    if (vc.type === 'stock') {
      const card = createStockCard(vc.data);
      card.dataset.createdAt = (vc.data.timestamp || Date.now()).toString();
      return card;
    }
    const card = createGenericCard(vc.data);
    card.dataset.createdAt = (vc.data.timestamp || Date.now()).toString();
    return card;
  }

  function scheduleVirtualRender(cardsEl) {
    if (virtualScrollRAF) return;
    virtualScrollRAF = requestAnimationFrame(() => {
      virtualScrollRAF = null;
      virtualScrollRender(cardsEl);
    });
  }

  function activateVirtualScroll(cardsEl) {
    if (virtualActive) return;
    virtualActive = true;
    console.log('[CONTENT] Virtual scrolling activated,', virtualCards.length, 'cards');

    // Convert existing DOM cards to virtual entries (if not already populated)
    if (virtualCards.length === 0) {
      const existing = cardsEl.querySelectorAll('.context-card, .ctx-video-divider');
      existing.forEach(el => {
        const vc = domCardToVirtual(el);
        if (vc) virtualCards.push(vc);
      });
    }

    // Attach scroll listener
    cardsEl.addEventListener('scroll', () => scheduleVirtualRender(cardsEl), { passive: true });

    // Clear DOM and do initial render
    virtualRenderedRange = { start: -1, end: -1 };
    cardsEl.innerHTML = '';
    virtualScrollRender(cardsEl);
  }

  function domCardToVirtual(el) {
    const h = el.offsetHeight || HEIGHT_COLLAPSED;
    if (el.classList.contains('ctx-video-divider')) {
      return { data: { term: el.textContent, type: 'video-divider' }, height: h, measuredHeight: h, type: 'divider', el: null, dismissed: false, highlighted: false };
    }
    const isInsight = el.classList.contains('insight-card');
    const isStock = el.classList.contains('stock-card');
    const term = el.querySelector('.card-term')?.textContent || '';
    const type = isInsight ? 'insight' : (isStock ? 'stock' : 'entity');
    return {
      data: { term, type: el.querySelector('.card-type')?.textContent?.toLowerCase() || 'concept' },
      height: h,
      measuredHeight: h,
      type,
      el: el, // preserve the already-rendered DOM element
      dismissed: el.classList.contains('card-dismissed'),
      highlighted: el.classList.contains('card-highlighted')
    };
  }

  function addVirtualCard(vc, cardsEl, prepend) {
    virtualCards[prepend ? 'unshift' : 'push'](vc);

    if (!virtualActive && virtualCards.length > VIRTUAL_THRESHOLD) {
      activateVirtualScroll(cardsEl);
      return;
    }

    if (virtualActive) {
      // Check if user is near bottom (for prepend, "bottom" is top since newest = first)
      const atTop = cardsEl.scrollTop < 100;
      virtualRenderedRange = { start: -1, end: -1 };
      virtualScrollRender(cardsEl);
      if (prepend && atTop) {
        cardsEl.scrollTop = 0;
      }
    }
  }

  function resetVirtualScroll() {
    virtualCards = [];
    virtualActive = false;
    virtualRenderedRange = { start: -1, end: -1 };
    if (virtualScrollRAF) { cancelAnimationFrame(virtualScrollRAF); virtualScrollRAF = null; }
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
      const vcType = entity.type === 'stock' ? 'stock' : 'entity';
      const vc = { data: entity, height: HEIGHT_COLLAPSED, measuredHeight: 0, type: vcType, el: null, dismissed: false, highlighted: false };

      if (virtualActive) {
        addVirtualCard(vc, cards, true);
      } else {
        const card = entity.type === 'stock'
          ? createStockCard(entity)
          : createGenericCard(entity);
        card.dataset.createdAt = Date.now().toString();
        cards.prepend(card);
        vc.el = card;
        virtualCards.unshift(vc);

        // Check if we should activate virtual scrolling
        if (virtualCards.length > VIRTUAL_THRESHOLD) {
          activateVirtualScroll(cards);
        }
      }
      termCount++;
      console.log('[CONTENT] Card added:', entity.ticker || entity.term || entity.name);
    });

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
          // Only reset if no cards exist (fresh session, not resume)
          const existingCards = shadowRoot?.getElementById('cards');
          const hasExistingCards = existingCards && existingCards.children.length > 0;
          if (!hasExistingCards) {
            resetSidebar();
          }
          chrome.storage.local.get('currentSessionId', (data) => {
            mySessionId = data.currentSessionId || null;
          });
        }
      });
    }
    // Video switch divider — triggered by URL change, not title change
    if (changes.videoSwitched && changes.videoSwitched.newValue) {
      // Update Now Watching bar — use document.title (most current) with changes as fallback
      {
        const bar = shadowRoot?.getElementById('ctx-now-watching');
        if (bar) {
          const pageTitle = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
          const changesTitle = changes.capturingTabTitle ? changes.capturingTabTitle.newValue.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim() : '';
          const displayTitle = (pageTitle && pageTitle !== 'YouTube') ? pageTitle : changesTitle;
          if (displayTitle) {
            bar.querySelector('.ctx-now-watching-title').textContent = displayTitle;
          }
        }
      }

      // Create divider for the previous video
      chrome.storage.local.get(['previousVideoTitle', 'previousVideoUrl'], (data) => {
        const prevTitle = escapeHtml(
          (data.previousVideoTitle || 'Previous video')
            .replace(/\s*-\s*YouTube$/i, '')
            .replace(/^\(\d+\)\s*/, '')
            .trim()
        ) || 'Previous video';
        const prevUrl = data.previousVideoUrl || '';

        const cards = shadowRoot?.getElementById('cards');
        if (cards && cards.children.length > 0) {
          // Remove any existing dividers to prevent stacking
          cards.querySelectorAll('.ctx-video-divider').forEach(d => d.remove());

          const prevCardCount = cards.querySelectorAll('.context-card').length;

          const link = prevUrl
            ? `<a href="${escapeHtml(prevUrl)}" target="_blank" class="ctx-divider-link">${prevTitle}</a>`
            : `<span class="ctx-divider-link">${prevTitle}</span>`;

          const divider = document.createElement('div');
          divider.className = 'ctx-video-divider';
          divider.innerHTML = `
            <div class="ctx-divider-prev">
              <span class="ctx-divider-label">PREVIOUS</span>
              ${link}
              <span class="ctx-divider-count">${prevCardCount} card${prevCardCount !== 1 ? 's' : ''}</span>
            </div>
            <div class="ctx-divider-line-full"></div>
          `;

          cards.prepend(divider);
        }
      });
    }
    if (changes.capturing) {
      const btn = shadowRoot?.getElementById('ctx-listen-btn');
      if (changes.capturing.newValue === true) {
        ensureBadge();
        setBadgeCapturing(true, false);
        if (btn) { btn.textContent = '\u25A0'; btn.title = 'Stop Recording'; btn.classList.add('listening'); }
        // Auto-open sidebar on capture start if enabled
        chrome.storage.local.get('userSettings', (data) => {
          const us = data.userSettings || {};
          if (us.autoOpen !== false) {
            isActiveTab((active) => {
              if (active) { ensureSidebar(); openSidebar(); }
            });
          }
        });
        // Show Now Watching bar — read document.title directly
        {
          const bar = shadowRoot?.getElementById('ctx-now-watching');
          if (bar) {
            const title = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
            if (title && title !== 'YouTube') {
              bar.querySelector('.ctx-now-watching-title').textContent = title;
              bar.style.display = 'flex';
            }
          }
        }
      } else if (changes.capturing.newValue === false) {
        setBadgeCapturing(false, false);
        if (btn) { btn.textContent = '\u25B6'; btn.title = 'Start Listening'; btn.classList.remove('listening'); }
        // Hide Now Watching bar
        const nwBar = shadowRoot?.getElementById('ctx-now-watching');
        if (nwBar) nwBar.style.display = 'none';
      }
    }
    if (changes.capturing && changes.capturing.oldValue === true && changes.capturing.newValue === false) {
      isActiveTab((active) => {
        if (!active) return;
        chrome.storage.local.get(['sessionHistory', 'knowledgeBase', 'capturingTabTitle', 'cardReactions', 'sessionQA'], (data) => {
          const history = data.sessionHistory || [];
          const kb = data.knowledgeBase || {};
          const title = data.capturingTabTitle || document.title || 'Untitled Video';
          const summaryReactions = data.cardReactions || {};
          const summaryQA = data.sessionQA || [];
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
            ${watchNextHTML}
            <button class="ctx-session-summary-dismiss">Dismiss</button>
          `;

          summaryEl.querySelector('.ctx-session-summary-export').addEventListener('click', (e) => {
            e.stopPropagation();
            const guide = generateStudyGuide(title, history, kb, window.location.href, summaryReactions, summaryQA);
            copyToClipboard(guide).then(() => {
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
    {
      const newEntities = changes.pendingEntities?.newValue || [];
      const newInsights = changes.pendingInsights?.newValue || [];
      if (newEntities.length === 0 && newInsights.length === 0) { /* skip — nothing to render */ }
      else {
        console.log('[CONTENT] onChanged fired, entities:', newEntities.length, 'insights:', newInsights.length);
        // Hide entire KB matches wrapper once cards start appearing
        const kbWrapper = shadowRoot?.getElementById('kb-matches-wrapper');
        if (kbWrapper) {
          kbWrapper.classList.remove('visible');
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
                  const vc = { data: insight, height: HEIGHT_INSIGHT, measuredHeight: 0, type: 'insight', el: null, dismissed: false, highlighted: false };
                  if (virtualActive) {
                    addVirtualCard(vc, cards, true);
                  } else {
                    const card = createInsightCard(insight);
                    card.dataset.createdAt = Date.now().toString();
                    cards.prepend(card);
                    vc.el = card;
                    virtualCards.unshift(vc);
                    addToNotes(card);
                    if (virtualCards.length > VIRTUAL_THRESHOLD) {
                      activateVirtualScroll(cards);
                    }
                  }
                });
              }
            }
            // Clean up storage after rendering both
            chrome.storage.local.remove(['pendingEntities', 'pendingInsights']);
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
          card.dataset.createdAt = Date.now().toString();
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
                card.dataset.createdAt = Date.now().toString();
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

  // --- YouTube SPA navigation: detect video switches directly ---
  let lastDetectedUrl = window.location.href;
  function handleUrlChange() {
    const newUrl = window.location.href;
    if (newUrl === lastDetectedUrl) return;
    const oldUrl = lastDetectedUrl;
    lastDetectedUrl = newUrl;

    const getVid = (url) => {
      try { return new URL(url).searchParams.get('v') || ''; }
      catch (e) { return ''; }
    };
    const oldVid = getVid(oldUrl);
    const newVid = getVid(newUrl);
    if (!oldVid || !newVid || oldVid === newVid) return;

    try { if (!chrome.runtime?.id) return; } catch (e) { return; }

    chrome.storage.local.get('capturing', (data) => {
      if (!data.capturing) return;
      const cards = shadowRoot?.getElementById('cards');
      if (!cards || cards.children.length === 0) return;
      // Skip if a divider was already added by the storage listener
      const firstChild = cards.firstElementChild;
      if (firstChild && firstChild.classList.contains('ctx-video-divider')) return;

      const prevTitle = escapeHtml(
        (document.title || 'Previous video')
          .replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim()
      ) || 'Previous video';
      const prevCardCount = cards.querySelectorAll('.context-card').length;
      const link = oldUrl
        ? `<a href="${escapeHtml(oldUrl)}" target="_blank" class="ctx-divider-link">${prevTitle}</a>`
        : `<span class="ctx-divider-link">${prevTitle}</span>`;
      const divider = document.createElement('div');
      divider.className = 'ctx-video-divider';
      divider.innerHTML = `
        <div class="ctx-divider-prev">
          <span class="ctx-divider-label">PREVIOUS</span>
          ${link}
          <span class="ctx-divider-count">${prevCardCount} card${prevCardCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="ctx-divider-line-full"></div>
      `;
      cards.prepend(divider);
      console.log('[CONTENT] Video switch divider added via SPA detection:', oldVid, '->', newVid);

      // Update Now Watching bar
      const bar = shadowRoot?.getElementById('ctx-now-watching');
      if (bar) {
        const newTitle = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
        if (newTitle && newTitle !== 'YouTube') {
          bar.querySelector('.ctx-now-watching-title').textContent = newTitle;
        }
      }
    });
  }
  document.addEventListener('yt-navigate-finish', handleUrlChange);
  window.addEventListener('popstate', handleUrlChange);

  // --- Toggle sidebar helper ---
  function toggleSidebar() {
    ensureSidebar();
    if (hostEl && hostEl.dataset.open === 'true') {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  // --- Keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+X — toggle sidebar (legacy)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'X') {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    // Alt+Shift shortcuts
    if (e.altKey && e.shiftKey) {
      if (e.key === 'X' || e.code === 'KeyX') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'S' || e.code === 'KeyS') {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' });
      } else if (e.key === 'C' || e.code === 'KeyC') {
        e.preventDefault();
        if (!shadowRoot) return;
        const clipboardBtn = shadowRoot.querySelector('[data-action="clipboard"]');
        if (clipboardBtn) clipboardBtn.click();
      }
    }
  });

  // --- Sync Now Watching bar on every init (only on capturing tab) ---
  chrome.storage.local.get(['capturing', 'activeTabUrl'], (data) => {
    if (data.capturing && data.activeTabUrl) {
      let isCapturingTab = false;
      try {
        const active = new URL(data.activeTabUrl);
        const current = new URL(window.location.href);
        isCapturingTab = active.origin + active.pathname === current.origin + current.pathname;
      } catch (e) {
        isCapturingTab = data.activeTabUrl === window.location.href;
      }
      if (!isCapturingTab) return;

      ensureSidebar();
      const bar = shadowRoot?.getElementById('ctx-now-watching');
      if (bar) {
        const title = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
        if (title && title !== 'YouTube') {
          bar.querySelector('.ctx-now-watching-title').textContent = title;
          bar.style.display = 'flex';
        }
      }
    }
  });

  // --- Listen for messages from background ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
    } else if (msg.type === 'CAPTURE_STATE') {
      const btn = shadowRoot?.getElementById('ctx-listen-btn');
      if (btn) {
        if (msg.capturing) {
          btn.textContent = '\u25A0'; btn.title = 'Stop Recording';
          btn.classList.add('listening');
        } else {
          btn.textContent = '\u25B6'; btn.title = 'Start Listening';
          btn.classList.remove('listening');
        }
      }
    } else if (msg.type === 'CONNECTION_ERROR') {
      if (!shadowRoot) return;
      const bar = shadowRoot.getElementById('ctx-status-bar');
      if (!bar) return;
      if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = null; }
      consecutiveErrors++;
      const icon = bar.querySelector('.ctx-status-icon');
      const text = bar.querySelector('.ctx-status-text');
      const serviceNames = { transcription: 'Transcription', analysis: 'Analysis', audio: 'Audio' };
      const name = serviceNames[msg.service] || msg.service;
      if (consecutiveErrors >= 3) {
        bar.className = 'ctx-status-bar visible error';
        icon.textContent = '\u2716';
        text.textContent = 'Connection failed. Try stopping and restarting capture.';
      } else {
        bar.className = 'ctx-status-bar visible warning';
        icon.textContent = '\u26A0';
        text.textContent = name + ' connection lost, retrying...';
      }
    } else if (msg.type === 'CONNECTION_RESTORED') {
      if (!shadowRoot) return;
      const bar = shadowRoot.getElementById('ctx-status-bar');
      if (!bar) return;
      if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = null; }
      consecutiveErrors = 0;
      const icon = bar.querySelector('.ctx-status-icon');
      const text = bar.querySelector('.ctx-status-text');
      bar.className = 'ctx-status-bar visible success';
      icon.textContent = '\u2714';
      text.textContent = 'Reconnected';
      statusHideTimer = setTimeout(() => {
        bar.className = 'ctx-status-bar';
        statusHideTimer = null;
      }, 3000);
    } else if (msg.type === 'TRANSCRIPT_TEXT') {
      if (!shadowRoot) return;
      const scroll = shadowRoot.querySelector('.ctx-transcript-scroll');
      if (!scroll) return;
      // Clear empty state on first chunk
      const empty = scroll.querySelector('.ctx-transcript-empty');
      if (empty) empty.remove();
      const chunk = document.createElement('div');
      chunk.className = 'ctx-transcript-chunk';
      const d = new Date(msg.timestamp);
      const timeStr = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const timeSpan = document.createElement('span');
      timeSpan.className = 'ctx-transcript-time';
      timeSpan.textContent = timeStr;
      const textSpan = document.createElement('span');
      textSpan.className = 'ctx-transcript-text';
      textSpan.textContent = msg.text;
      chunk.appendChild(timeSpan);
      chunk.appendChild(textSpan);
      scroll.appendChild(chunk);
      if (transcriptAutoScroll) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    } else if (msg.type === 'TRANSCRIPT_HIGHLIGHT') {
      if (!shadowRoot) return;
      const scroll = shadowRoot.querySelector('.ctx-transcript-scroll');
      if (!scroll) return;
      const terms = msg.terms || [];
      // Highlight in the last few transcript chunks (most recent text)
      const chunks = scroll.querySelectorAll('.ctx-transcript-chunk');
      const recent = Array.from(chunks).slice(-5);
      terms.forEach(({ term, type }) => {
        if (!term) return;
        const color = getTypeColor(type);
        recent.forEach(chunk => {
          const textSpan = chunk.querySelector('.ctx-transcript-text');
          if (!textSpan) return;
          const html = textSpan.innerHTML;
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp('\\b(' + escaped + ')\\b', 'gi');
          const newHtml = html.replace(regex, '<span class="ctx-transcript-highlight" style="color:' + color + ';background:' + color + '15;">$1</span>');
          if (newHtml !== html) {
            textSpan.innerHTML = newHtml;
          }
        });
      });
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
