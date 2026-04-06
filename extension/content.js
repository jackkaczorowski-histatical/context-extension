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
  let missedNewCards = 0;
  let lastDividerTime = 0;
  let loadingTimeout5 = null;
  let loadingTimeout15 = null;
  let loadingTimeout30 = null;

  // Virtual scrolling state
  const VIRTUAL_THRESHOLD = 50;
  const VIRTUAL_BUFFER = 5;
  const HEIGHT_COLLAPSED = 36;
  const HEIGHT_EXPANDED = 100;
  const HEIGHT_INSIGHT = 32;
  const HEIGHT_DIVIDER = 48;
  let virtualCards = []; // { data, height, type: 'entity'|'insight'|'stock'|'divider', el: null }
  let virtualActive = false;
  let virtualScrollRAF = null;
  let virtualRenderedRange = { start: -1, end: -1 };
  const isYouTubeSite = window.location.hostname.includes('youtube.com');

  const TYPE_COLORS = {
    concept: '#3b82f6',
    person: '#ef4444',
    people: '#ef4444',
    organization: '#8b5cf6',
    event: '#f59e0b',
    place: '#14b8a6',
    technique: '#ec4899',
    why: '#eab308',
    tradeoff: '#f97316',
    stock: '#22c55e',
    commodity: '#f97316',
    ingredient: '#84cc16',
    work: '#ec4899',
    legislation: '#f97316',
    metric: '#06b6d4'
  };

  let cardsRenderedThisSession = 0;
  let cardsExpandedThisSession = 0;

  function computeCardScore(entity) {
    const novelty = 1.0 - (entity.familiarity || 0);
    const salienceMap = { 'highlight': 1.0, 'background': 0.4 };
    const salience = salienceMap[entity.salience] || 0.6;
    const ageMs = Date.now() - (entity.timestamp || Date.now());
    const recency = Math.max(0, 1.0 - (ageMs / (5 * 60 * 1000)));
    return (novelty * 0.45) + (salience * 0.35) + (recency * 0.2);
  }

  function toggleCardExpand(card) {
    if (card.classList.contains('expanded')) {
      // Collapsing — record dwell time
      const expandedAt = parseInt(card.dataset.expandedAt || '0');
      if (expandedAt) {
        const dwellMs = Date.now() - expandedAt;
        if (dwellMs > 500) {
          try { chrome.runtime.sendMessage({ type: 'CARD_DWELL', term: card.dataset.term || '', dwellMs, entityType: card.dataset.entityType || '' }); } catch (e) {}
        }
        delete card.dataset.expandedAt;
      }
      card.classList.remove('expanded');
      if (currentlyExpandedCard === card) currentlyExpandedCard = null;
    } else {
      if (!allowMultipleExpand && currentlyExpandedCard && currentlyExpandedCard !== card) {
        // Record dwell on the card being auto-collapsed
        const prevAt = parseInt(currentlyExpandedCard.dataset.expandedAt || '0');
        if (prevAt) {
          const dwellMs = Date.now() - prevAt;
          if (dwellMs > 500) {
            try { chrome.runtime.sendMessage({ type: 'CARD_DWELL', term: currentlyExpandedCard.dataset.term || '', dwellMs, entityType: currentlyExpandedCard.dataset.entityType || '' }); } catch (e) {}
          }
          delete currentlyExpandedCard.dataset.expandedAt;
        }
        currentlyExpandedCard.classList.remove('expanded');
      }
      card.classList.add('expanded');
      card.dataset.expandedAt = Date.now().toString();
      currentlyExpandedCard = card;
      // Track first expansion
      if (!card.dataset.wasExpanded) {
        card.dataset.wasExpanded = 'true';
        cardsExpandedThisSession++;
      }
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

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
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
      isolation: isolate;
      --bg-primary: #0a0a14;
      --bg-surface: #12121e;
      --bg-surface-hover: #1a1a2e;
      --border-subtle: rgba(255, 255, 255, 0.06);
      --text-primary: #e0e0f0;
      --text-secondary: #64748b;
      --text-tertiary: #3a3a5a;
      --accent: #14b8a6;
      --type-person: #ef4444;
      --type-place: #14b8a6;
      --type-concept: #3b82f6;
      --type-event: #f59e0b;
      --type-organization: #8b5cf6;
      --type-stock: #22c55e;
      --type-insight: #eab308;
      --type-work: #ec4899;
      --type-legislation: #f97316;
      --type-metric: #06b6d4;
      --type-ingredient: #84cc16;
      background: var(--bg-primary);
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    *:focus { outline: none; }
    #sidebar {
      position: relative; width: 100%; height: 100%; background: var(--bg-primary);
      display: flex; flex-direction: column; overflow: hidden; margin: 0; padding: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      color: var(--text-primary);
      border-left: 1px solid var(--border-subtle);
      box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
      border-radius: 0;
      transform: translateX(100%) scale(0.98);
      transition: transform 200ms ease-in;
    }
    #sidebar[data-pos="left"] { transform: translateX(-100%) scale(0.98); }
    #sidebar.open {
      transform: translateX(0) scale(1) !important;
      transition: transform 250ms cubic-bezier(0.0, 0.0, 0.2, 1);
    }
    #header {
      display: flex; flex-direction: column; background: var(--bg-primary); flex-shrink: 0;
      overflow: visible;
    }
    .ctx-header-row1 {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .ctx-header-row1-left { display: flex; align-items: center; gap: 8px; }
    .ctx-header-row1-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .ctx-header-row2 {
      display: flex; align-items: center; justify-content: center;
      padding: 2px 12px; gap: 12px;
      border-bottom: 1px solid var(--border-subtle);
      position: relative; overflow: visible;
    }
    .ctx-toolbar-btn {
      background: none; border: none; color: var(--text-tertiary); font-size: 9px;
      font-family: inherit; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.04em; cursor: pointer; padding: 2px 4px;
      line-height: 1; transition: color 0.15s; flex-shrink: 0; border-radius: 4px;
      white-space: nowrap;
    }
    .ctx-toolbar-btn:hover { color: var(--text-primary); }
    .ctx-toolbar-btn.active { color: var(--accent); }
    .ctx-wordmark { font-size: 14px; font-weight: 700; color: var(--text-primary); letter-spacing: -0.01em; }
    .ctx-live { display: flex; align-items: center; gap: 5px; }
    .ctx-live-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #00e676;
      opacity: 0.3;
    }
    @keyframes livePulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .ctx-live-dot.active {
      opacity: 1;
      animation: livePulse 2s ease-in-out infinite;
    }
    .ctx-live-text { font-size: 10px; color: #00e676; font-weight: 500; }
    .ctx-export-btn { position: relative; }
    .ctx-clear-btn:hover { color: #ef4444; }
    .ctx-close-btn {
      background: none; border: none; color: var(--text-secondary); font-size: 18px;
      cursor: pointer; padding: 0 4px; line-height: 1; transition: color 0.15s;
      flex-shrink: 0; width: 28px; text-align: center;
    }
    .ctx-close-btn:hover { color: #f8fafc; }
    .ctx-clear-confirm {
      position: absolute; right: 0; top: 50%; transform: translateY(-50%);
      background: var(--bg-primary); z-index: 10; padding: 4px 12px;
      font-size: 11px; color: #ef4444; display: inline-flex; align-items: center; gap: 8px;
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
      display: none; position: absolute; top: 100%; right: 8px;
      background: var(--bg-surface); border: 1px solid var(--border-subtle);
      border-radius: 8px; padding: 4px 0; z-index: 200;
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
    #empty-state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      background: var(--bg-primary);
    }
    .ctx-waveform { display: flex; align-items: center; gap: 3px; height: 24px; }
    .ctx-waveform span {
      width: 2px; background: var(--text-tertiary); border-radius: 1px;
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
    .transcript-ticker {
      padding: 3px 12px; font-size: 10px; color: var(--text-tertiary);
      font-style: italic; overflow: hidden; white-space: nowrap;
      text-overflow: ellipsis; max-height: 18px;
      transition: opacity 200ms ease;
    }
    .transcript-ticker.hidden { opacity: 0; max-height: 0; padding: 0 12px; overflow: hidden; }
    .empty-state-returning { text-align: center; padding: 24px 16px; }
    .last-session-summary {
      font-size: 11px; color: var(--text-secondary); line-height: 1.5;
      margin-bottom: 8px;
    }
    .start-btn-large {
      display: block; width: 80%; margin: 24px auto; padding: 12px 24px;
      background: var(--accent); color: white; border: none; border-radius: 8px;
      font-size: 14px; font-weight: 600; cursor: pointer;
      font-family: inherit; transition: background 150ms ease;
    }
    .start-btn-large:hover { background: #0d9488; }
    .light-theme .start-btn-large { color: #fff; }
    /* ─── Suggested videos ─── */
    .suggested-section {
      padding: 16px;
    }
    .suggested-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }
    .suggested-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .suggested-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-surface);
      border-radius: 6px;
      text-decoration: none;
      transition: background 150ms ease;
      cursor: pointer;
    }
    .suggested-item:hover {
      background: var(--bg-surface-hover);
    }
    .suggested-category {
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
      flex-shrink: 0;
    }
    .suggested-title {
      font-size: 12px;
      color: var(--text-primary);
    }
    .ctx-usage-countdown {
      font-size: 12px; color: var(--text-secondary); margin-top: 8px;
    }
    #listening-indicator {
      display: none; align-items: center; gap: 8px;
      padding: 8px 16px; background: var(--bg-primary);
      border-bottom: 1px solid var(--border-subtle);
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
      font-size: 10px; color: var(--text-primary); line-height: 18px; max-width: 100%;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
      padding: 3px 12px; flex-shrink: 0; display: none; font-style: italic;
      background: rgba(255,255,255,0.05); border-bottom: 1px solid var(--border-subtle);
      -webkit-mask-image: linear-gradient(to right, black 70%, transparent 100%);
      mask-image: linear-gradient(to right, black 70%, transparent 100%);
      transition: background 0.5s ease, opacity 0.3s ease;
    }
    #transcript-strip.visible { display: block; }
    #transcript-strip.flash { background: rgba(99,102,241,0.15); }
    #transcript-strip.paused { opacity: 0.4; }
    .ctx-silence-indicator { color: var(--text-secondary); font-style: normal; margin-left: 8px; }
    #cards {
      flex: 1; overflow-y: auto; padding: 0; background: var(--bg-primary); display: none;
      position: relative; z-index: 1;
    }
    #cards::-webkit-scrollbar { width: 3px; }
    #cards::-webkit-scrollbar-track { background: transparent; }
    #cards::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
    .context-card {
      position: relative; padding: 8px 12px;
      border-bottom: 1px solid var(--border-subtle); border-left: 3px solid var(--text-tertiary);
      background: var(--bg-surface);
      animation: cardEntrance 200ms cubic-bezier(0.0, 0.0, 0.2, 1) forwards;
      cursor: pointer; user-select: none; overflow: hidden;
      border-radius: 8px; margin: 4px 8px 0 8px;
      transition: box-shadow 150ms ease, transform 150ms ease, background 150ms ease;
    }
    .context-card:hover {
      background: var(--bg-surface-hover);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      transform: translateY(-1px);
    }
    .context-card[data-entity-type="person"] { border-left: 3px solid var(--type-person); }
    .context-card[data-entity-type="people"] { border-left: 3px solid var(--type-person); }
    .context-card[data-entity-type="place"] { border-left: 3px solid var(--type-place); }
    .context-card[data-entity-type="concept"] { border-left: 3px solid var(--type-concept); }
    .context-card[data-entity-type="event"] { border-left: 3px solid var(--type-event); }
    .context-card[data-entity-type="organization"] { border-left: 3px solid var(--type-organization); }
    .context-card[data-entity-type="stock"] { border-left: 3px solid var(--type-stock); }
    .context-card[data-entity-type="work"] { border-left: 3px solid var(--type-work); }
    .context-card[data-entity-type="legislation"] { border-left: 3px solid var(--type-legislation); }
    .context-card[data-entity-type="metric"] { border-left: 3px solid var(--type-metric); }
    .context-card[data-entity-type="ingredient"] { border-left: 3px solid var(--type-ingredient); }
    @keyframes cardEntrance {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .context-card.collapsed { animation: none; cursor: default; }
    .context-card.card-dismissed { opacity: 0.5 !important; transition: opacity 0.2s; animation: none; }
    .context-card.card-dismissed:hover { opacity: 0.7; }
    .card-quick-dismiss {
      position: absolute; top: 2px; right: 2px; left: auto; width: 18px; height: 18px;
      border-radius: 50%; background: rgba(255, 255, 255, 0.05); border: none;
      color: var(--text-tertiary); font-size: 10px; cursor: pointer;
      display: none; align-items: center; justify-content: center;
      padding: 0; z-index: 5;
    }
    .context-card:hover .card-quick-dismiss,
    .insight-strip:hover .card-quick-dismiss { display: flex; }

    .card-quick-dismiss:hover { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    @keyframes cardRipple {
      0% { box-shadow: inset 0 0 0 1px rgba(20, 184, 166, 0.5); }
      100% { box-shadow: inset 0 0 0 1px transparent; }
    }
    .context-card.remention { animation: cardRipple 800ms ease-out; }
    .card-dismiss-inline {
      width: 16px; height: 16px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.15); background: none;
      color: rgba(255,255,255,0.3); font-size: 8px; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: all 0.2s; padding: 0; line-height: 1; flex-shrink: 0;
      margin-left: auto; position: relative; z-index: 3;
    }
    .card-dismiss-inline:hover { border-color: rgba(0,230,118,0.5); color: #00e676; background: rgba(0,230,118,0.1); }
    .context-card.card-dismissed .card-dismiss-inline { border-color: rgba(0,230,118,0.6); color: #fff; background: #00c853; }
    .card-dismiss-inline.dismiss-starred { background: #eab308; border-color: #eab308; color: #fff; }
    .card-dismiss-inline.dismiss-starred:hover { background: #ca9a06; border-color: #ca9a06; }
    .card-row {
      display: flex; flex-direction: column; gap: 2px;
    }
    .card-row-top {
      display: flex; align-items: center; gap: 6px;
    }
    .card-type {
      font-size: 8px; font-weight: 700; letter-spacing: 0.05em;
      text-transform: uppercase; flex-shrink: 0;
      padding: 1px 5px; border-radius: 4px;
    }
    .card-term {
      font-size: 14px; font-weight: 600; color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .context-card.expanded .card-term {
      white-space: normal; overflow: visible; text-overflow: unset; word-break: break-word;
    }
    .card-time { font-size: 10px; font-weight: 400; color: var(--text-secondary); flex-shrink: 0; cursor: pointer; text-decoration: none; }
    .card-time:hover { text-decoration: underline; }
    .card-seen { font-size: 9px; color: #94a3b8; font-style: italic; flex-shrink: 0; }
    .card-rectx { font-size: 9px; color: #7070ff; flex-shrink: 0; }
    .context-card.recontextualized { border-left-color: #7070ff; background: rgba(112, 112, 255, 0.04); }
    .context-card.recontextualized:hover { background: rgba(112, 112, 255, 0.08); }
    .card-chevron {
      font-size: 12px; color: var(--text-tertiary); flex-shrink: 0;
      transition: transform 0.2s ease; line-height: 1;
    }
    .context-card.expanded .card-chevron { transform: rotate(90deg); }
    .card-expand-area {
      max-height: 0; overflow: hidden; opacity: 0; padding-top: 0;
      transition: max-height 200ms cubic-bezier(0.4, 0.0, 0.2, 1), opacity 150ms ease 50ms, padding-top 200ms ease;
      display: flex; flex-direction: column;
    }
    .context-card.expanded .card-expand-area {
      max-height: 500px; opacity: 1; padding-top: 6px;
    }
    .card-desc { font-size: 12px; font-weight: 400; color: #a0a0c0; line-height: 1.4; word-wrap: break-word; overflow-wrap: break-word; max-width: 100%; }
    .card-thumbnail {
      width: 100%; height: 80px; object-fit: cover;
      border-radius: 4px; margin-bottom: 6px;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .card-thumbnail.loaded { opacity: 1; }
    .card-thumb {
      display: block; width: 100%; height: 80px; object-fit: cover;
      border-radius: 4px; margin-bottom: 6px;
    }
    .card-source { font-size: 10px; color: #94a3b8; margin-top: 4px; font-style: italic; }
    .card-popularity { font-size: 9px; color: var(--text-tertiary); margin-top: 4px; }
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
      background: var(--bg-surface); box-shadow: inset 2px 0 8px rgba(34, 197, 94, 0.1);
    }
    .context-card.stock-card:hover { background: var(--bg-surface-hover); }
    .stock-ticker-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
    .stock-ticker { font-size: 18px; font-weight: 700; color: var(--text-primary); }
    .stock-company { font-size: 11px; color: var(--text-secondary); }
    .stock-price-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .stock-price { font-size: 20px; font-weight: 700; color: var(--text-primary); }
    .stock-change { font-size: 13px; font-weight: 600; }
    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }
    .stock-52w-labels { display: flex; justify-content: space-between; font-size: 10px; color: #6a6a8a; margin-bottom: 2px; }
    .stock-52w-bar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; position: relative; margin: 2px 0 6px; }
    .stock-52w-fill { position: absolute; left: 0; top: 0; height: 100%; border-radius: 2px; background: #38bdf8; }
    .stock-52w-dot { position: absolute; top: -3px; width: 10px; height: 10px; background: var(--text-primary); border-radius: 50%; border: 2px solid var(--bg-surface-hover); }
    .stock-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; padding: 8px 0; border-top: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle); margin: 8px 0; }
    .stock-stat-label { font-size: 10px; color: var(--text-secondary); }
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
    .card-actions-row {
      display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: nowrap; width: 100%;
    }
    .card-actions-row .card-wiki-link,
    .card-actions-row .card-tellmore,
    .card-actions-row .card-copy-btn { margin-top: 0; }
    .reaction-row {
      display: flex; gap: 6px; margin-left: auto; align-items: center; flex-shrink: 0;
    }
    .reaction-btn {
      width: 24px; height: 24px; border-radius: 50%; background: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; cursor: pointer; transition: opacity 0.3s, transform 0.2s;
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
    @keyframes reactionPop {
      0% { transform: scale(1); }
      50% { transform: scale(1.2); }
      100% { transform: scale(1); }
    }
    .reaction-btn.just-clicked {
      animation: reactionPop 200ms ease;
    }
    .card-highlighted { border-left-color: #eab308 !important; background: rgba(234,179,8,0.05); }
    .context-card.reacted { opacity: 0.65; transition: opacity 0.2s; }
    .context-card.reacted:hover { opacity: 0.85; }
    .ctx-filter-bar {
      display: flex; gap: 6px; padding: 4px 12px;
      background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
      align-items: center;
    }
    .ctx-filter-btn {
      font-size: 9px; padding: 2px 8px; border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.1); background: none;
      color: var(--text-secondary); cursor: pointer; font-family: inherit; transition: all 0.15s;
    }
    .ctx-filter-btn:hover { border-color: rgba(255,255,255,0.2); color: #94a3b8; }
    .ctx-filter-btn.active { background: rgba(99,102,241,0.15); color: #818cf8; border-color: rgba(99,102,241,0.3); }
    .filter-hide-known .context-card.card-dismissed { display: none; }
    .filter-starred-only .context-card:not(.card-highlighted) { display: none; }
    .collapse-all .context-card .card-expand-area { max-height: 0; opacity: 0; padding-top: 0; }
    .collapse-all .context-card .card-chevron { transform: rotate(0deg); }
    .reaction-label {
      display: none;
    }
    .reaction-group { display: flex; align-items: center; }
    .card-wiki-link {
      font-size: 10px; color: var(--text-tertiary); text-decoration: none;
      transition: color 0.15s; display: inline-block; padding: 0;
      background: none; border: none;
    }
    .card-wiki-link:hover { color: var(--accent); }
    .card-shop-link {
      background: rgba(255,153,0,0.12); color: #FF9900; border-radius: 4px;
      padding: 4px 12px; font-size: 10px; text-decoration: none;
      display: inline-block; margin-top: 8px; transition: background 0.15s;
    }
    .card-shop-link:hover { background: rgba(255,153,0,0.22); }
    .card-tellmore {
      font-size: 10px; color: var(--text-tertiary); background: none;
      border: none; border-radius: 0; padding: 0; cursor: pointer;
      margin-left: 0; font-family: inherit;
      display: inline-block; transition: color 0.15s;
    }
    .card-tellmore:hover { color: var(--accent); }
    .followups-toggle {
      font-size: 9px; color: var(--text-tertiary); cursor: pointer;
      margin-top: 4px; padding: 2px 0; transition: color 150ms ease;
    }
    .followups-toggle:hover { color: var(--text-secondary); }
    .card-followups {
      display: flex; flex-direction: row; flex-wrap: wrap; gap: 3px;
      max-height: 0; overflow: hidden; opacity: 0;
      transition: max-height 150ms ease, opacity 150ms ease;
    }
    .card-followups.show { max-height: 200px; opacity: 1; margin-top: 4px; }
    .followup-chip {
      font-size: 9px; color: #a5b4fc; background: rgba(99,102,241,0.08);
      border: 1px solid rgba(99,102,241,0.2); border-radius: 4px;
      padding: 3px 6px; cursor: pointer; font-family: inherit;
      text-align: left; line-height: 1.3; transition: background 0.15s, border-color 0.15s;
    }
    .followup-chip:hover { background: rgba(99,102,241,0.18); border-color: rgba(99,102,241,0.4); }
    .card-copy-btn {
      background: none; color: var(--text-tertiary); border: none;
      border-radius: 0; padding: 0; cursor: pointer;
      font-size: 10px; font-family: inherit;
      display: inline-block; transition: color 0.15s;
    }
    .card-copy-btn:hover { color: var(--accent); }
    .card-copy-btn.copied { color: #00e676; background: none; }
    .card-preview-text { font-size: 11px; color: var(--text-secondary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .context-card:not([data-visited="true"]):not(.expanded) .card-preview-text { display: none; }
    .context-card[data-visited="true"]:not(.expanded) .card-preview-text { display: block; }
    .context-card.expanded .card-preview-text { display: none; }
    .ctx-card-tooltip {
      position: absolute; background: var(--bg-surface); border: 1px solid var(--border-subtle);
      border-radius: 8px; padding: 8px 12px; font-size: 12px; color: var(--text-primary);
      max-width: 240px; z-index: 9999; pointer-events: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4); line-height: 1.5; word-wrap: break-word;
    }
    .context-card.high-relevance { border-left-width: 3px; border-left-color: rgba(99, 102, 241, 0.7) !important; }
    .context-card.high-relevance .card-term { color: #a5b4fc; }
    .light-theme .context-card.high-relevance .card-term { color: #6366f1; }
    .context-card.salience-background { opacity: 0.65; border-left-color: transparent !important; }
    .context-card.salience-background .card-term { font-size: 11px; }
    .context-card.salience-background .card-type { font-size: 7px; }
    .insight-strip {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 6px 12px; border-left: 2px solid rgba(234, 179, 8, 0.5);
      border-radius: 0; margin: 2px 0; background: rgba(234, 179, 8, 0.03);
      cursor: pointer; position: relative; overflow: visible;
      transition: background 150ms ease;
    }
    .insight-strip:hover { background: rgba(234, 179, 8, 0.06); }
    .insight-strip .insight-category {
      font-size: 8px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.05em; color: #eab308; flex-shrink: 0; margin-top: 2px;
    }
    .insight-strip .insight-body { flex: 1; min-width: 0; }
    .insight-strip .insight-text {
      font-size: 11px; color: #b0b0c8; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .insight-strip.expanded .insight-text {
      white-space: normal; overflow: visible;
    }
    .insight-strip .insight-detail {
      display: none; font-size: 11px; color: #9090a8; margin-top: 4px; line-height: 1.3;
    }
    .insight-strip.expanded .insight-detail { display: block; }
    .insight-strip .insight-time {
      font-size: 10px; color: #3a3a5a; flex-shrink: 0; margin-top: 2px;
    }
    .insight-strip:not(.expanded) .card-actions-row { display: none; }
    .insight-strip:not(.expanded) .reaction-row { display: none; }
    .insight-strip .card-actions-row {
      display: flex; align-items: center; gap: 8px; margin-top: 6px; width: 100%;
    }
    .feedback-msg { font-size: 11px; color: var(--text-tertiary); padding: 4px 0; text-align: center; }
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
      width: 28px; height: 28px; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; padding: 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    #ctx-listen-btn:hover { background: #00c853; }
    #ctx-listen-btn.listening { background: #ef4444; }
    #ctx-listen-btn.listening:hover { background: #dc2626; }

    /* ─── Preview card ─── */
    .ctx-preview-card {
      display: none; padding: 12px 16px; background: var(--bg-surface);
      border-left: 3px solid #5a5aff; border-bottom: 1px solid var(--border-subtle);
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
      flex-shrink: 0; padding: 12px; background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
      box-shadow: 0 -4px 12px rgba(0,0,0,0.3);
    }
    .ctx-ask-input {
      width: 100%; height: 36px; background: var(--bg-surface-hover);
      border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      padding: 0 12px; font-size: 12px; color: var(--text-primary);
      font-family: inherit; outline: none;
      transition: border-color 0.2s;
    }
    .ctx-ask-input::placeholder { color: #6a6a8a; }
    .ctx-ask-input:focus { border-color: rgba(90,90,255,0.4); }
    .ctx-ask-response {
      display: none; padding: 12px; font-size: 12px; color: var(--text-primary);
      line-height: 1.5; max-height: 200px; overflow-y: auto;
      background: rgba(255,255,255,0.05);
      border-top: 1px solid var(--border-subtle); position: relative;
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
    .light-theme .followup-chip { color: #4f46e5; background: rgba(99,102,241,0.06); border-color: rgba(99,102,241,0.15); }
    .light-theme .followup-chip:hover { background: rgba(99,102,241,0.12); border-color: rgba(99,102,241,0.3); }
    .light-theme .card-copy-btn { background: rgba(99,102,241,0.08); color: #6366f1; }
    .light-theme .card-copy-btn:hover { background: rgba(99,102,241,0.15); }
    .light-theme .card-copy-btn.copied { color: #059669; background: rgba(5,150,105,0.08); }
    .light-theme .card-quick-dismiss { background: rgba(0, 0, 0, 0.04); color: rgba(0,0,0,0.35); }
    .light-theme .card-quick-dismiss:hover { background: rgba(239, 68, 68, 0.1); color: #dc2626; }
    .light-theme .card-dismiss-inline { border-color: rgba(0,0,0,0.15); color: rgba(0,0,0,0.3); }
    .light-theme .card-dismiss-inline:hover { border-color: rgba(5,150,105,0.5); color: #059669; background: rgba(5,150,105,0.1); }
    .light-theme .context-card.card-dismissed .card-dismiss-inline { border-color: rgba(5,150,105,0.6); color: #fff; background: #059669; }
    .light-theme .insight-strip { background: rgba(234, 179, 8, 0.05); border-left-color: rgba(234, 179, 8, 0.6); }
    .light-theme .insight-strip .insight-text { color: #4a4a60; }
    .light-theme .insight-strip .insight-detail { color: #6a6a80; }
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
      background: var(--bg-surface); border: 1px solid rgba(90,90,255,0.15);
      border-radius: 8px; padding: 16px; margin: 12px;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .ctx-session-summary.visible { opacity: 1; }
    .ctx-session-summary-header {
      font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px;
    }
    .ctx-session-summary-headline {
      font-size: 12px; color: #c0c0e0; margin-bottom: 8px; line-height: 1.4;
    }
    .ctx-session-summary-headline strong { color: #e0e0f0; font-weight: 600; }
    .ctx-session-summary-topics {
      font-size: 10px; color: #7a7a9a; margin-bottom: 8px; line-height: 1.5;
    }
    .ctx-session-summary-kb {
      font-size: 10px; color: #5a5a7a; margin-bottom: 10px; line-height: 1.4;
    }
    .ctx-session-summary-stats {
      font-size: 11px; color: #9a9ab0; line-height: 1.6;
    }
    .ctx-session-summary-export-prompt {
      font-size: 12px; color: var(--accent); margin-top: 10px; line-height: 1.5;
    }
    .ctx-session-summary-actions { display: flex; gap: 8px; margin-top: 12px; }
    .ctx-session-summary-export {
      background: rgba(90,90,255,0.15); color: #a0a0ff; border: none;
      border-radius: 4px; padding: 8px 16px; font-size: 11px;
      cursor: pointer; font-family: inherit;
    }
    .ctx-session-summary-export:hover { background: rgba(90,90,255,0.25); }
    .ctx-session-summary-viewkb {
      background: rgba(20,184,166,0.12); color: var(--accent); border: none;
      border-radius: 4px; padding: 8px 16px; font-size: 11px;
      cursor: pointer; font-family: inherit;
    }
    .ctx-session-summary-viewkb:hover { background: rgba(20,184,166,0.22); }
    .ctx-session-summary-dismiss {
      display: block; font-size: 10px; color: var(--text-tertiary); margin-top: 8px;
      cursor: pointer; text-decoration: none; background: none; border: none;
      padding: 0; font-family: inherit;
    }
    .ctx-session-summary-dismiss:hover { color: #5a5a7a; }
    .light-theme .ctx-session-summary { background: #f0f0fa; border-color: rgba(90,90,255,0.12); }
    .light-theme .ctx-session-summary-header { color: #1a1a2e; }
    .light-theme .ctx-session-summary-headline { color: #3a3a5a; }
    .light-theme .ctx-session-summary-headline strong { color: #1a1a2e; }
    .light-theme .ctx-session-summary-topics { color: #7a7a9a; }
    .light-theme .ctx-session-summary-kb { color: #9a9ab0; }
    .light-theme .ctx-session-summary-stats { color: #5a5a7a; }
    .light-theme .ctx-session-summary-viewkb { background: rgba(20,184,166,0.08); }
    .light-theme .ctx-session-summary-viewkb:hover { background: rgba(20,184,166,0.15); }
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

    .time-divider {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px; margin: 4px 0;
    }
    .time-divider-line { flex: 1; height: 1px; background: var(--border-subtle); }
    .time-divider-label {
      font-size: 10px; font-weight: 600; color: var(--text-tertiary);
      letter-spacing: 0.05em;
    }

    .ctx-now-watching {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
      min-width: 0;
    }
    .ctx-now-watching.visible { display: flex; }
    .ctx-now-watching-label {
      font-size: 8px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ctx-now-watching-title {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.6);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    /* ─── Onboarding overlay ─── */
    .ctx-onboarding {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg-primary); z-index: 100;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 32px 24px; text-align: center;
    }
    .ctx-onboarding-title {
      font-size: 18px; font-weight: 700; color: var(--text-primary);
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
      background: var(--accent); color: #0a0a14; border: none; border-radius: 8px;
      padding: 12px 24px; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: background 0.15s; font-family: inherit;
    }
    .ctx-onboarding-btn:hover { background: #0d9488; }
    .ctx-onboarding-dots {
      display: flex; gap: 8px; margin-top: 28px;
    }
    .ctx-onboarding-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--text-tertiary); transition: background 0.2s;
    }
    .ctx-onboarding-dot.active { background: var(--accent); }
    .ctx-onboarding-skip { background: none; border: none; color: var(--text-secondary); font-size: 12px; cursor: pointer; margin-top: 8px; font-family: inherit; padding: 4px 8px; }
    .ctx-onboarding-skip:hover { color: #94a3b8; }
    .light-theme .ctx-onboarding { background: #f5f5f8; }
    .light-theme .ctx-onboarding-title { color: #1a1a2e; }
    .light-theme .ctx-onboarding-body { color: #64748b; }
    .light-theme .ctx-onboarding-btn { color: #fff; }
    .light-theme .ctx-onboarding-dot { background: #cbd5e1; }
    .light-theme .ctx-onboarding-dot.active { background: #14b8a6; }
    .light-theme .ctx-onboarding-skip { color: #94a3b8; }
    .light-theme .ctx-onboarding-skip:hover { color: #64748b; }

    /* ─── Usage limit overlay ─── */
    .ctx-usage-limit {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg-primary); z-index: 100;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 32px 24px; text-align: center;
    }
    .ctx-usage-limit-title {
      font-size: 18px; font-weight: 700; color: var(--text-primary);
      margin-bottom: 12px;
    }
    .ctx-usage-limit-body {
      font-size: 13px; color: #94a3b8; line-height: 1.6;
      margin-bottom: 20px; max-width: 240px;
    }
    .ctx-usage-limit-meter {
      font-size: 12px; color: #ef4444; font-weight: 600;
      margin-bottom: 20px;
    }
    .ctx-usage-limit-link {
      display: inline-block; font-size: 12px; color: #14b8a6;
      text-decoration: underline; cursor: pointer; margin-bottom: 16px;
    }
    .ctx-usage-limit-link:hover { color: #2dd4bf; }
    .ctx-usage-limit-upgrade {
      background: var(--accent); color: white; border: none; border-radius: 8px;
      padding: 10px 24px; font-size: 13px; font-weight: 600; cursor: pointer;
      margin-bottom: 12px; display: block; width: 100%; font-family: inherit;
      transition: background 150ms ease;
    }
    .ctx-usage-limit-upgrade:hover { background: #0d9488; }
    .ctx-usage-limit-dismiss {
      background: none; border: 1px solid rgba(255,255,255,0.1); color: #64748b;
      border-radius: 6px; padding: 8px 20px; font-size: 12px; cursor: pointer;
      font-family: inherit; transition: all 0.15s;
    }
    .ctx-usage-limit-dismiss:hover { color: #e0e0f0; border-color: rgba(255,255,255,0.2); }
    .light-theme .ctx-usage-limit { background: #f5f5f8; }
    .light-theme .ctx-usage-limit-title { color: #1a1a2e; }
    .light-theme .ctx-usage-limit-body { color: #64748b; }
    .light-theme .ctx-usage-limit-dismiss { border-color: rgba(0,0,0,0.1); color: #9a9ab0; }
    .light-theme .ctx-usage-limit-dismiss:hover { color: #333; border-color: rgba(0,0,0,0.2); }
    /* ─── Usage warning banner ─── */
    .ctx-usage-warning {
      padding: 6px 12px;
      background: rgba(234, 179, 8, 0.1);
      border-bottom: 1px solid rgba(234, 179, 8, 0.2);
      font-size: 11px;
      color: #eab308;
      text-align: center;
    }
    .ctx-usage-warning .upgrade-link { cursor: pointer; text-decoration: underline; }
    .ctx-usage-warning .upgrade-link:hover { color: #facc15; }
    .light-theme .ctx-usage-warning { background: rgba(234, 179, 8, 0.08); }

    /* ─── Usage footer indicator ─── */
    .ctx-usage-footer {
      padding: 4px 12px; text-align: center;
      font-size: 10px; color: var(--text-tertiary); flex-shrink: 0;
      border-top: 1px solid var(--border-subtle);
    }
    .light-theme .ctx-usage-footer { color: #9a9ab0; border-top-color: rgba(0,0,0,0.04); }

    /* ─── Auth section in settings ─── */
    .ctx-auth-section {
      padding: 12px 0; margin-bottom: 8px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .ctx-google-btn {
      width: 100%; padding: 9px 16px; border-radius: 6px;
      background: #fff; border: 1px solid #dadce0; color: #3c4043;
      font-size: 13px; font-weight: 500; cursor: pointer;
      font-family: inherit; display: flex; align-items: center;
      justify-content: center; gap: 10px; transition: background 0.15s;
    }
    .ctx-google-btn:hover { background: #f7f8f8; }
    .ctx-google-btn svg { width: 18px; height: 18px; flex-shrink: 0; }
    .ctx-auth-hint {
      font-size: 11px; color: #64748b; text-align: center;
      margin-top: 8px; line-height: 1.4;
    }
    .ctx-auth-profile {
      display: flex; align-items: center; gap: 10px;
    }
    .ctx-auth-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      object-fit: cover; flex-shrink: 0;
    }
    .ctx-auth-info { flex: 1; min-width: 0; }
    .ctx-auth-name {
      font-size: 13px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ctx-auth-email {
      font-size: 11px; color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ctx-auth-badge {
      font-size: 9px; font-weight: 700; text-transform: uppercase;
      padding: 2px 8px; border-radius: 4px; letter-spacing: 0.05em;
      margin-left: 8px; vertical-align: middle;
    }
    .ctx-auth-badge.free { background: rgba(100,116,139,0.15); color: #94a3b8; }
    .ctx-auth-badge.pro { background: rgba(20,184,166,0.15); color: var(--accent); }
    .ctx-auth-signout {
      background: none; border: none; color: #ef4444; font-size: 11px;
      cursor: pointer; font-family: inherit; margin-top: 8px;
      opacity: 0.7; transition: opacity 0.15s;
    }
    .ctx-auth-signout:hover { opacity: 1; }
    .light-theme .ctx-auth-section { border-bottom-color: rgba(0,0,0,0.06); }
    .light-theme .ctx-auth-name { color: #1a1a2e; }

    /* ─── Settings panel ─── */
    .ctx-settings-btn.active { color: var(--accent); }
    .light-theme .ctx-settings-btn.active { color: var(--accent); }
    .ctx-settings-panel {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg-primary); z-index: 90;
      display: flex; flex-direction: column;
      overflow-y: auto; overflow-x: hidden;
      padding: 16px;
      transform: translateX(100%);
      transition: transform 0.2s ease-out;
    }
    .ctx-settings-panel.open { transform: translateX(0); }
    .light-theme .ctx-settings-panel { background: #f5f5f8; }
    .ctx-settings-heading {
      font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 16px;
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
    .ctx-settings-radio:hover { border-color: rgba(255,255,255,0.2); color: var(--text-primary); }
    .ctx-settings-radio.active { border-color: var(--accent); color: var(--accent); background: rgba(20,184,166,0.08); }
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
    .ctx-settings-chip.active { border-color: var(--accent); color: var(--accent); background: rgba(20,184,166,0.08); }
    .light-theme .ctx-settings-chip { border-color: rgba(0,0,0,0.12); color: #94a3b8; }
    .light-theme .ctx-settings-chip:hover { border-color: rgba(0,0,0,0.25); color: #64748b; }
    .light-theme .ctx-settings-chip.active { border-color: #14b8a6; color: #0d9488; background: rgba(20,184,166,0.08); }
    .ctx-settings-toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 0;
    }
    .ctx-settings-toggle-label {
      font-size: 12px; color: var(--text-primary);
    }
    .light-theme .ctx-settings-toggle-label { color: #1a1a2e; }
    .ctx-settings-toggle {
      position: relative; width: 36px; height: 20px; border-radius: 10px;
      background: var(--text-tertiary); cursor: pointer; transition: background 0.2s;
      border: none; padding: 0; flex-shrink: 0;
    }
    .ctx-settings-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #94a3b8; transition: all 0.2s;
    }
    .ctx-settings-toggle.on { background: var(--accent); }
    .ctx-settings-toggle.on::after { left: 18px; background: #fff; }
    .light-theme .ctx-settings-toggle { background: #cbd5e1; }
    .light-theme .ctx-settings-toggle::after { background: #fff; }
    .light-theme .ctx-settings-toggle.on { background: #14b8a6; }
    .ctx-settings-done {
      margin-top: auto; padding: 12px 0; border-radius: 8px;
      background: var(--accent); color: #0a0a14; border: none; font-size: 13px;
      font-weight: 600; cursor: pointer; transition: background 0.15s;
      font-family: inherit; width: 100%;
    }
    .ctx-settings-done:hover { background: #0d9488; }
    .light-theme .ctx-settings-done { color: #fff; }
    #cards.hide-insights .insight-strip { display: none; }

    /* ─── History panel ─── */
    .ctx-history-btn.active { color: var(--accent); }
    .light-theme .ctx-history-btn.active { color: var(--accent); }
    .ctx-history-panel {
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg-primary); z-index: 89;
      display: flex; flex-direction: column;
      overflow: hidden;
      transform: translateX(100%);
      transition: transform 0.2s ease-out;
    }
    .ctx-history-panel.open { transform: translateX(0); }
    .light-theme .ctx-history-panel { background: #f5f5f8; }
    .ctx-history-header {
      display: flex; align-items: center; padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
    }
    .light-theme .ctx-history-header { border-bottom-color: rgba(0,0,0,0.08); }
    .ctx-history-back {
      background: none; border: none; color: #94a3b8; font-size: 13px;
      cursor: pointer; padding: 0; font-family: inherit; transition: color 0.15s;
    }
    .ctx-history-back:hover { color: #e0e0f0; }
    .light-theme .ctx-history-back:hover { color: #1a1a2e; }
    .ctx-history-title {
      font-size: 14px; font-weight: 700; color: var(--text-primary); margin-left: 12px;
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
      padding: 12px 16px; cursor: pointer;
      border-bottom: 1px solid var(--border-subtle);
      transition: background 0.15s;
      position: relative;
    }
    .ctx-history-item:hover { background: rgba(255,255,255,0.03); }
    .session-delete {
      position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
      background: none; border: none; color: var(--text-tertiary);
      font-size: 14px; cursor: pointer; padding: 4px 6px; border-radius: 4px;
      display: none; z-index: 2;
    }
    .ctx-history-item:hover .session-delete { display: block; }
    .session-delete:hover { color: #ef4444; background: rgba(239,68,68,0.1); }
    .session-folder-btn {
      position: absolute; top: 50%; right: 28px; transform: translateY(-50%);
      background: none; border: none; color: var(--text-tertiary);
      font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 4px;
      display: none; z-index: 2;
    }
    .ctx-history-item:hover .session-folder-btn { display: block; }
    .session-folder-btn:hover { color: var(--accent); }
    .session-folder-dot {
      width: 8px; height: 8px; border-radius: 50%; display: inline-block;
      margin-right: 6px; flex-shrink: 0;
    }
    .session-folder-dropdown {
      position: absolute; top: calc(50% + 16px); right: 28px;
      background: var(--bg-surface); border: 1px solid var(--border-subtle);
      border-radius: 8px; padding: 4px; z-index: 10;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); min-width: 120px;
    }
    .session-folder-dropdown-item {
      display: flex; align-items: center; gap: 6px; padding: 6px 10px;
      font-size: 10px; color: var(--text-primary); cursor: pointer;
      border-radius: 4px; border: none; background: none; width: 100%;
      text-align: left; font-family: inherit;
    }
    .session-folder-dropdown-item:hover { background: rgba(255,255,255,0.06); }
    .session-folder-dropdown-item.active { color: var(--accent); font-weight: 600; }
    .folder-bar {
      display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .folder-chip {
      font-size: 10px; padding: 3px 10px; border-radius: 12px;
      border: 1px solid var(--border-subtle); background: none;
      color: var(--text-secondary); cursor: pointer; transition: all 150ms ease;
      font-family: inherit;
    }
    .folder-chip.active { background: var(--accent); color: white; border-color: var(--accent); }
    .folder-chip:hover:not(.active) { border-color: var(--text-tertiary); }
    .folder-add {
      font-size: 10px; padding: 3px 10px; border-radius: 12px;
      border: 1px dashed var(--text-tertiary); background: none;
      color: var(--text-tertiary); cursor: pointer; font-family: inherit;
    }
    .folder-add:hover { border-color: var(--accent); color: var(--accent); }
    .folder-create {
      display: flex; gap: 4px; align-items: center;
    }
    .folder-name-input {
      font-size: 10px; padding: 3px 8px; border-radius: 8px;
      border: 1px solid var(--border-subtle); background: var(--bg-surface);
      color: var(--text-primary); width: 120px; outline: none; font-family: inherit;
    }
    .folder-name-input:focus { border-color: var(--accent); }
    .folder-save {
      font-size: 12px; padding: 2px 6px; border-radius: 4px;
      border: none; background: var(--accent); color: white; cursor: pointer;
    }
    .light-theme .ctx-history-item { border-bottom-color: rgba(0,0,0,0.04); }
    .light-theme .ctx-history-item:hover { background: rgba(0,0,0,0.03); }
    .ctx-history-item-title {
      font-size: 12px; font-weight: 600; color: var(--text-primary);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; line-height: 1.4; margin-bottom: 4px;
    }
    .light-theme .ctx-history-item-title { color: #1a1a2e; }
    .ctx-history-item-meta {
      display: flex; align-items: center; gap: 8px; font-size: 10px; color: #64748b;
    }
    .ctx-history-item-badge {
      background: rgba(20,184,166,0.12); color: var(--accent);
      padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: 500;
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
      font-size: 12px; font-weight: 600; color: var(--text-primary);
    }
    .light-theme .ctx-history-entity-term { color: #1a1a2e; }
    .ctx-history-entity-type {
      font-size: 9px; font-weight: 700; padding: 4px 8px; border-radius: 4px;
      margin-left: 8px; text-transform: uppercase; vertical-align: middle;
      letter-spacing: 0.05em;
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
    .ctx-history-export-row {
      display: flex; gap: 6px; margin-bottom: 10px; padding-bottom: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .ctx-history-export-btn {
      flex: 1; padding: 7px 0; border-radius: 6px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
      color: #94a3b8; font-size: 11px; font-weight: 500;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
      text-align: center;
    }
    .ctx-history-export-btn:hover { background: rgba(255,255,255,0.1); color: #e0e0f0; }
    .light-theme .ctx-history-export-row { border-bottom-color: rgba(0,0,0,0.06); }
    .light-theme .ctx-history-export-btn { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.08); color: #64748b; }
    .light-theme .ctx-history-export-btn:hover { background: rgba(0,0,0,0.08); color: #1a1a2e; }
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
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-primary);
    }
    .light-theme .ctx-view-tabs { background: #f5f5f8; border-bottom-color: rgba(0,0,0,0.08); }
    .ctx-view-tab {
      flex: 1; padding: 4px 0; background: none; border: none;
      border-bottom: 2px solid transparent;
      color: #64748b; font-size: 12px; font-weight: 600;
      cursor: pointer; font-family: inherit; transition: all 0.15s;
      text-align: center;
    }
    .ctx-view-tab:hover { color: #94a3b8; }
    .ctx-view-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
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
    .ctx-cards-area { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .new-cards-pill {
      position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
      background: var(--accent); color: white; padding: 6px 16px; border-radius: 20px;
      font-size: 11px; font-weight: 600; cursor: pointer; z-index: 10;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); display: none;
      transition: opacity 150ms ease; font-family: inherit;
    }
    .new-cards-pill.visible { display: block; }
    .ctx-transcript-scroll {
      flex: 1; overflow-y: auto; padding: 12px 16px;
      font-size: 12px; line-height: 1.5; color: var(--text-primary);
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
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-primary);
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
      display: none; align-items: center; gap: 8px;
      padding: 8px 16px; font-size: 11px; flex-shrink: 0;
      border-bottom: 1px solid var(--border-subtle);
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

    /* ─── Floating widget (sidebar closed + capturing) ─── */
    .floating-widget {
      position: fixed; bottom: 20px; right: 20px;
      width: 44px; height: 44px; border-radius: 50%;
      background: var(--bg-surface); border: 1px solid var(--border-subtle);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      cursor: pointer; z-index: 2147483646;
      display: none; align-items: center; justify-content: center;
      transition: transform 150ms ease, box-shadow 150ms ease;
      pointer-events: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .floating-widget.visible { display: flex; }
    .floating-widget:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
    }
    .widget-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #ef4444;
      animation: livePulse 2s ease-in-out infinite;
    }
    .widget-count {
      position: absolute; top: -4px; right: -4px;
      background: var(--accent); color: white;
      font-size: 10px; font-weight: 700;
      min-width: 18px; height: 18px; border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      padding: 0 4px;
    }
    .light-theme .floating-widget { background: #fff; border-color: rgba(0,0,0,0.1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .light-theme .floating-widget:hover { box-shadow: 0 6px 16px rgba(0,0,0,0.2); }

    /* Why-this-card tooltip */
    .card-why-tooltip {
      position: absolute; top: -32px; left: 12px;
      background: #1e1e2e; color: var(--text-secondary);
      font-size: 10px; padding: 4px 8px; border-radius: 4px;
      white-space: nowrap; pointer-events: none;
      opacity: 0; transition: opacity 150ms ease;
      z-index: 10; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .context-card:hover .card-why-tooltip { opacity: 1; }
    .light-theme .card-why-tooltip { background: #fff; color: #64748b; box-shadow: 0 2px 8px rgba(0,0,0,0.12); }

    /* Focus indicators */
    .context-card:focus-visible, .insight-strip:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* Reduced motion */
    @media (prefers-reduced-motion: reduce) {
      .context-card,
      .insight-strip,
      .card-expand-area,
      .floating-widget,
      .live-dot.active {
        animation: none !important;
        transition: none !important;
      }
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

    // Sync floating widget count
    const widgetCount = shadowRoot?.querySelector('.widget-count');
    if (widgetCount) widgetCount.textContent = termCount;
  }

  function setBadgeCapturing(capturing, paused) {
    if (!badgeShadow) return;
    const badge = badgeShadow.querySelector('.ctx-badge');
    if (!badge) return;
    badge.classList.toggle('capturing', capturing);
    badge.classList.toggle('not-capturing', !capturing);
    badge.classList.toggle('paused', capturing && paused);
    updateFloatingWidget(capturing);
  }

  function updateFloatingWidget(capturing) {
    if (!shadowRoot) return;
    const widget = shadowRoot.querySelector('.floating-widget');
    if (!widget) return;
    const sidebarOpen = hostEl && hostEl.dataset.open === 'true';
    // Infer capturing state from badge if not provided
    if (capturing === undefined) {
      const badge = badgeShadow?.querySelector('.ctx-badge');
      capturing = badge ? badge.classList.contains('capturing') : false;
    }
    const shouldShow = !sidebarOpen && !!capturing;
    widget.classList.toggle('visible', shouldShow);
    widget.querySelector('.widget-count').textContent = termCount;
    // Hide badge when widget is visible to prevent overlap
    if (badgeEl) badgeEl.style.display = shouldShow ? 'none' : '';
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
        btn: 'Next \u2192',
        link: { text: 'Read full privacy policy', href: 'https://context-extension-zv8d.vercel.app/privacy' }
      },
      {
        title: 'Sign in to sync',
        body: 'Sign in with Google to save your preferences and track your usage across devices.',
        signIn: true
      }
    ];

    let current = 0;
    const overlay = document.createElement('div');
    overlay.className = 'ctx-onboarding';

    function finishOnboarding() {
      chrome.storage.local.set({ onboardingComplete: true });
      overlay.remove();
    }

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

      if (step.signIn) {
        const signInBtn = document.createElement('button');
        signInBtn.className = 'ctx-google-btn';
        signInBtn.innerHTML = '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Sign in with Google';
        signInBtn.addEventListener('click', () => {
          signInBtn.disabled = true;
          signInBtn.style.opacity = '0.6';
          try { chrome.runtime.sendMessage({ type: 'GOOGLE_SIGN_IN' }); } catch (err) {}
          // Listen for sign-in result to close onboarding
          const onSignIn = (msg) => {
            if (msg.type === 'SIGN_IN_SUCCESS') {
              chrome.runtime.onMessage.removeListener(onSignIn);
              finishOnboarding();
            } else if (msg.type === 'SIGN_IN_ERROR') {
              chrome.runtime.onMessage.removeListener(onSignIn);
              signInBtn.disabled = false;
              signInBtn.style.opacity = '1';
            }
          };
          chrome.runtime.onMessage.addListener(onSignIn);
        });
        overlay.appendChild(signInBtn);

        const skip = document.createElement('button');
        skip.className = 'ctx-onboarding-skip';
        skip.textContent = 'Skip for now';
        skip.addEventListener('click', () => finishOnboarding());
        overlay.appendChild(skip);
      } else {
        const btn = document.createElement('button');
        btn.className = 'ctx-onboarding-btn';
        btn.textContent = step.btn;
        btn.addEventListener('click', () => {
          if (current < steps.length - 1) {
            current++;
            render();
          } else {
            finishOnboarding();
          }
        });
        overlay.appendChild(btn);
      }

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
    chrome.runtime.sendMessage({ type: 'SIDEBAR_OPENED' }).catch(() => {});
    updateFloatingWidget();
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
    chrome.runtime.sendMessage({ type: 'SIDEBAR_CLOSED' }).catch(() => {});
    updateFloatingWidget();
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
      card.classList.remove('card-dismissed', 'card-highlighted', 'reacted');
      row.querySelectorAll('.reaction-btn').forEach(b => b.classList.remove('active'));
      const dismissEl = card.querySelector('.card-dismiss-inline');
      if (dismissEl) {
        dismissEl.classList.remove('dismiss-starred');
        dismissEl.textContent = '\u2713';
      }
      if (!reaction) return;
      if (reaction === 'known') {
        card.classList.add('card-dismissed', 'reacted');
      } else if (reaction === 'new') {
        card.classList.add('card-highlighted', 'reacted');
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
        btn.classList.remove('just-clicked');
        void btn.offsetWidth; // force reflow to restart animation
        btn.classList.add('just-clicked');
        setTimeout(() => btn.classList.remove('just-clicked'), 200);
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
          try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'card_reaction', properties: { term: key, reaction: wasActive ? 'removed' : reaction, entity_type: entity.type || 'other' } }); } catch (e) {}
        });
      });

      row.appendChild(group);
    });

    // Append reactions to the actions row if present, otherwise to expand area
    const actionsRow = card.querySelector('.card-actions-row');
    if (actionsRow && !container) {
      actionsRow.appendChild(row);
    } else {
      expandArea.appendChild(row);
    }
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
    const strip = document.createElement('div');
    strip.className = 'insight-strip';
    strip.dataset.insightKey = insightKey(insight.insight || '');
    strip.dataset.entityType = 'insight';
    strip.setAttribute('tabindex', '0');
    strip.setAttribute('role', 'article');
    strip.setAttribute('aria-label', 'insight: ' + (insight.insight || ''));
    const vt = formatVideoTime();
    const category = escapeHtml(insight.category || 'insight');
    const insightText = insight.insight || '';
    const detail = escapeHtml(insight.detail || '');

    strip.innerHTML = `
      <span class="insight-category">INSIGHT</span>
      <div class="insight-body">
        <div class="insight-text">${escapeHtml(insightText)}</div>
        ${detail ? '<div class="insight-detail">' + detail + '</div>' : ''}
        <div class="card-actions-row">
          <button class="card-copy-btn">Copy text</button>
        </div>
      </div>
      <span class="insight-time" data-seek="${vt.seconds}">${vt.display}</span>
    `;

    strip.querySelector('.card-copy-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = insight.insight || '';
      const det = insight.detail || '';
      const copyText = text + (det ? ' \u2014 ' + det : '');
      copyToClipboard(copyText).then(() => {
        const btn = strip.querySelector('.card-copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy text'; btn.classList.remove('copied'); }, 1500);
      });
    });

    // Build reactions directly inside card-actions-row
    const actionsRow = strip.querySelector('.card-actions-row');
    if (actionsRow) {
      const insightReactionKey = (insight.insight || '').toLowerCase().trim();

      const knewBtn = document.createElement('button');
      knewBtn.className = 'reaction-btn reaction-known';
      knewBtn.textContent = '\u2713';
      knewBtn.title = 'Knew this';



      const newBtn = document.createElement('button');
      newBtn.className = 'reaction-btn reaction-new';
      newBtn.textContent = '\u2605';
      newBtn.title = 'New to me';

      function applyReaction(reaction) {
        strip.classList.remove('reacted');
        knewBtn.classList.remove('active');
        newBtn.classList.remove('active');
        if (reaction === 'known') { knewBtn.classList.add('active'); strip.classList.add('reacted'); }
        if (reaction === 'new') { newBtn.classList.add('active'); strip.classList.add('reacted'); }
      }

      chrome.storage.local.get('cardReactions', (data) => {
        const r = data.cardReactions || {};
        if (r[insightReactionKey]) applyReaction(r[insightReactionKey].reaction);
      });

      [{ btn: knewBtn, reaction: 'known' }, { btn: newBtn, reaction: 'new' }].forEach(({ btn, reaction }) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasActive = btn.classList.contains('active');
          chrome.storage.local.get('cardReactions', (data) => {
            const reactions = data.cardReactions || {};
            if (wasActive) { delete reactions[insightReactionKey]; applyReaction(null); }
            else { reactions[insightReactionKey] = { reaction, timestamp: Date.now(), type: 'insight' }; applyReaction(reaction); }
            chrome.storage.local.set({ cardReactions: reactions });
          });
        });
      });

      const reactionRow = document.createElement('div');
      reactionRow.className = 'reaction-row';
      reactionRow.appendChild(knewBtn);
      reactionRow.appendChild(newBtn);
      actionsRow.appendChild(reactionRow);
    }

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'card-quick-dismiss';
    dismissBtn.textContent = '\u2715';
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      strip.style.transition = 'opacity 200ms, transform 200ms, max-height 200ms';
      strip.style.opacity = '0';
      strip.style.transform = 'translateX(20px)';
      strip.style.maxHeight = '0';
      strip.style.overflow = 'hidden';
      strip.style.margin = '0';
      strip.style.padding = '0';
      setTimeout(() => strip.remove(), 200);
      try { chrome.runtime.sendMessage({ type: 'CARD_DISMISS', term: strip.dataset.insightKey || '' }); } catch (err) {}
    });
    strip.appendChild(dismissBtn);

    strip.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('.insight-copy-btn') || e.target.closest('.card-quick-dismiss')) return;
      const timeEl = e.target.closest('.insight-time');
      if (timeEl && timeEl.dataset.seek) { e.stopPropagation(); seekVideo(parseInt(timeEl.dataset.seek)); return; }
      strip.classList.toggle('expanded');
    });

    return strip;
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
    card.dataset.term = entity.ticker || entity.name || '';
    card.dataset.entityType = 'stock';
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', 'stock: ' + (entity.ticker || entity.name || ''));
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

    const stockWhyText = entity.fromPack ? 'Mentioned in a previous session'
      : entity.familiarity > 0.5 ? "You've seen this before but it came up again"
      : entity._score > 0.8 ? 'Highly relevant to this content'
      : entity.salience === 'highlight' ? 'Key term in this segment'
      : 'First mention in this session';
    card.dataset.why = stockWhyText;

    card.innerHTML = `
      <div class="card-why-tooltip">${escapeHtml(stockWhyText)}</div>
      <button class="card-quick-dismiss" title="Remove">\u00D7</button>
      <div class="card-row">
        <div class="card-row-top">
          <span class="card-type" style="color:${color}">STOCK</span>
          <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
          <span style="margin-left:auto;display:flex;gap:4px;align-items:center;">
            <span class="card-chevron">&#x203A;</span>
          </span>
        </div>
        <div class="card-term">${ticker || companyName}${collapsedPriceHTML}</div>
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

    // Quick dismiss (× button) — animate out and remove
    const stockQuickDismiss = card.querySelector('.card-quick-dismiss');
    if (stockQuickDismiss) {
      stockQuickDismiss.addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        card.style.transition = 'opacity 200ms ease, transform 200ms ease, max-height 200ms ease';
        card.style.opacity = '0';
        card.style.transform = 'translateX(20px)';
        card.style.maxHeight = card.offsetHeight + 'px';
        requestAnimationFrame(() => { card.style.maxHeight = '0'; card.style.margin = '0'; card.style.padding = '0'; card.style.borderWidth = '0'; });
        setTimeout(() => {
          card.remove();
          if (virtualActive) {
            const idx = virtualCards.findIndex(vc => vc.el === card);
            if (idx !== -1) virtualCards.splice(idx, 1);
          }
        }, 200);
        try {
          chrome.runtime.sendMessage({ type: 'CARD_DISMISS', term: key });
        } catch (err) {}
      });
    }

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
    card.dataset.term = entity.term || entity.name || '';
    card.dataset.entityType = entity.type || 'other';
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'article');
    card.setAttribute('aria-label', (entity.type || 'other') + ': ' + (entity.term || entity.name || ''));
    const type = entity.type || 'other';
    const color = getTypeColor(type);
    const isRectx = !!entity.recontextualized;

    if (isRectx) {
      card.classList.add('recontextualized');
    }
    if (entity.visited) {
      card.dataset.visited = 'true';
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

    const whyText = entity.fromPack ? 'Mentioned in a previous session'
      : entity.familiarity > 0.5 ? "You've seen this before but it came up again"
      : entity._score > 0.8 ? 'Highly relevant to this content'
      : entity.salience === 'highlight' ? 'Key term in this segment'
      : 'First mention in this session';
    card.dataset.why = whyText;

    card.innerHTML = `
      <div class="card-why-tooltip">${escapeHtml(whyText)}</div>
      <button class="card-quick-dismiss" title="Remove">\u00D7</button>
      <div class="card-row">
        <div class="card-row-top">
          ${typeBadge}
          <span class="card-time" data-seek="${vt.seconds}">${vt.display}</span>
          ${seenTag}
          <span class="card-chevron" style="margin-left:auto;">&#x203A;</span>
        </div>
        <div class="card-term">${termText}</div>
      </div>
      ${previewDesc ? `<div class="card-preview-text">${escapeHtml(previewDesc)}</div>` : ''}
      <div class="card-expand-area">
        ${entity.thumbnail ? `<img class="card-thumb" src="${escapeHtml(entity.thumbnail)}" alt="" />` : ''}
        <div class="card-desc"></div>
        ${sourceLine}
        <div class="card-actions-row">
          <a class="card-wiki-link" href="${wikiUrl}" target="_blank" rel="noopener">Wikipedia \u2192</a>
          <button class="card-tellmore">Tell me more</button>
          <button class="card-copy-btn">Copy text</button>
        </div>
        ${entity.followUps && entity.followUps.length > 0 ? `<div class="followups-toggle">\uD83D\uDCAC Questions</div><div class="card-followups">${entity.followUps.map(q => `<button class="followup-chip">${escapeHtml(q)}</button>`).join('')}</div>` : ''}
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

    // Quick dismiss (× button) — animate out and remove
    const quickDismissEl = card.querySelector('.card-quick-dismiss');
    if (quickDismissEl) {
      quickDismissEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        card.style.transition = 'opacity 200ms ease, transform 200ms ease, max-height 200ms ease';
        card.style.opacity = '0';
        card.style.transform = 'translateX(20px)';
        card.style.maxHeight = card.offsetHeight + 'px';
        requestAnimationFrame(() => { card.style.maxHeight = '0'; card.style.margin = '0'; card.style.padding = '0'; card.style.borderWidth = '0'; });
        setTimeout(() => {
          card.remove();
          // Remove from virtual cards if active
          if (virtualActive) {
            const idx = virtualCards.findIndex(vc => vc.el === card);
            if (idx !== -1) virtualCards.splice(idx, 1);
          }
        }, 200);
        // Tell background to suppress re-extraction this session
        try {
          chrome.runtime.sendMessage({ type: 'CARD_DISMISS', term: genericDismissKey });
        } catch (err) {}
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

      // Mark as visited on first expand
      if (card.classList.contains('expanded') && !card.dataset.visited) {
        card.dataset.visited = 'true';
        const visitedTerm = card.dataset.term;
        chrome.storage.local.get('sessionHistory', (data) => {
          const hist = data.sessionHistory || [];
          const match = hist.find(h => (h.term || '').toLowerCase() === (visitedTerm || '').toLowerCase());
          if (match) {
            match.visited = true;
            chrome.storage.local.set({ sessionHistory: hist });
          }
        });
      }

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
          try { if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'CONTEXT_FETCH', term: termName }); } catch (e) {}
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
              if (expandArea && !expandArea.querySelector('.card-thumbnail') && !expandArea.querySelector('.card-thumb')) {
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

    card.querySelector('.followups-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const followups = card.querySelector('.card-followups');
      if (followups) followups.classList.toggle('show');
    });

    card.querySelectorAll('.followup-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const input = shadowRoot.querySelector('.ctx-ask-input');
        if (input) {
          askEntityLabel = entity.term || entity.name || '';
          input.value = chip.textContent;
          input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
      });
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

    guide += `---\nGenerated with Context \u2014 a live AI study guide for any video\nhttps://chromewebstore.google.com/detail/context/${chrome.runtime.id}`;
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

    html += `<hr style="border:none;border-top:1px solid #ccc;margin:16px 0 8px 0;"><p style="margin:0;font-size:12px;color:#888;">Generated with <a href="https://chromewebstore.google.com/detail/context/${chrome.runtime.id}" style="color:#14b8a6;text-decoration:none;">Context</a> \u2014 a live AI study guide for any video</p>`;
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
    sidebar.setAttribute('role', 'complementary');
    sidebar.setAttribute('aria-label', 'Context Listener sidebar');

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
        <button class="ctx-export-btn ctx-toolbar-btn" title="Export study guide">EXPORT<span class="ctx-export-tooltip">Copied!</span></button>
        <div class="ctx-export-menu"><button class="ctx-export-menu-item" data-action="clipboard">Copy to clipboard</button><button class="ctx-export-menu-item" data-action="gmail">Open in Gmail</button><button class="ctx-export-menu-item" data-action="download">Download as .txt</button></div>
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
        const liveDot = header.querySelector('.ctx-live-dot');
        if (liveDot) liveDot.classList.add('active');
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
      if (!e.target.closest('.ctx-export-btn') && !e.target.closest('.ctx-export-menu')) {
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
      try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'export', properties: { method: 'clipboard' } }); } catch (e2) {}
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
      try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'export', properties: { method: 'gmail' } }); } catch (e2) {}
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
      try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'export', properties: { method: 'download' } }); } catch (e2) {}
    });

    // Empty state
    const emptyState = document.createElement('div');
    emptyState.id = 'empty-state';
    emptyState.innerHTML = `
      <div class="ctx-waveform"><span></span><span></span><span></span><span></span></div>
      <div class="transcript-ticker hidden"><span class="ticker-text"></span></div>
      <div class="ctx-empty-text">Listening for context...</div>
      <div id="kb-matches-wrapper">
        <div class="kb-matches-toggle">\u25BE You've explored related topics before</div>
        <div id="empty-kb-matches"></div>
      </div>
      <div class="empty-state-returning" style="display:none;"></div>
      <div class="suggested-section" style="display:none;"></div>
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

    // Returning user empty state: show last session info when not capturing
    chrome.storage.local.get(['capturing', 'pastSessions'], (data) => {
      if (data.capturing) return;
      const sessions = data.pastSessions || [];

      // First-time user on YouTube: show suggested videos
      if (sessions.length === 0 && isYouTubeSite) {
        const suggestedDiv = emptyState.querySelector('.suggested-section');
        if (suggestedDiv) {
          const suggestedVideos = [
            { title: 'History of France (8 min)', url: 'https://www.youtube.com/watch?v=I_vNNKzwVq4', category: 'History' },
            { title: 'How The Economic Machine Works (30 min)', url: 'https://www.youtube.com/watch?v=PHe0bXAIuk0', category: 'Finance' },
            { title: 'The Most Misunderstood Concept in Physics (27 min)', url: 'https://www.youtube.com/watch?v=DxL2HoqLbyA', category: 'Science' }
          ];
          suggestedDiv.innerHTML =
            '<div class="suggested-label">Try it on one of these:</div>' +
            '<div class="suggested-list">' +
            suggestedVideos.map(v =>
              '<div class="suggested-item" data-url="' + escapeHtml(v.url) + '">' +
              '<span class="suggested-category">' + escapeHtml(v.category) + '</span>' +
              '<span class="suggested-title">' + escapeHtml(v.title) + '</span>' +
              '</div>'
            ).join('') +
            '</div>';
          suggestedDiv.querySelectorAll('.suggested-item').forEach(item => {
            item.addEventListener('click', () => {
              const url = item.dataset.url;
              chrome.storage.local.set({ reopenSidebar: true, autoStartCapture: true }, () => {
                window.location.href = url;
              });
            });
          });
          suggestedDiv.style.display = '';
        }
        return;
      }

      if (sessions.length === 0) return;
      const last = sessions[0];
      const returningDiv = emptyState.querySelector('.empty-state-returning');
      if (!returningDiv) return;
      const title = last.title || 'Untitled';
      const count = (last.entities || []).length;
      const ago = last.timestamp ? timeAgo(last.timestamp) : '';
      returningDiv.innerHTML =
        '<div class="last-session-summary">Last session: ' + escapeHtml(title) + ' &mdash; ' + count + ' terms' + (ago ? ', ' + ago : '') + '</div>' +
        '<button class="start-btn-large">\u25B6 Start Capturing</button>';
      returningDiv.style.display = '';
      // Hide waveform and listening text — user isn't capturing yet
      const waveform = emptyState.querySelector('.ctx-waveform');
      if (waveform) waveform.style.display = 'none';
      const emptyTextEl = emptyState.querySelector('.ctx-empty-text');
      if (emptyTextEl) emptyTextEl.style.display = 'none';
      const kbWrapper = emptyState.querySelector('#kb-matches-wrapper');
      if (kbWrapper) kbWrapper.style.display = 'none';
      // Also hide suggested section for returning users
      const suggestedDiv = emptyState.querySelector('.suggested-section');
      if (suggestedDiv) suggestedDiv.style.display = 'none';
      returningDiv.querySelector('.start-btn-large').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' });
        returningDiv.style.display = 'none';
        // Restore waveform and listening text for active capture
        if (waveform) waveform.style.display = '';
        if (emptyTextEl) emptyTextEl.style.display = '';
        if (kbWrapper) kbWrapper.style.display = '';
      });
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
      try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'tab_switch', properties: { tab: view } }); } catch (e) {}
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
    cardContainer.setAttribute('role', 'feed');
    cardContainer.setAttribute('aria-label', 'Entity cards');

    // Keyboard navigation for cards
    cardContainer.addEventListener('keydown', (e) => {
      const focused = shadowRoot.activeElement;
      if (!focused) return;
      const isCard = focused.classList.contains('context-card') || focused.classList.contains('insight-strip');
      if (!isCard) return;

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focused.classList.contains('insight-strip')) {
          focused.classList.toggle('expanded');
        } else {
          toggleCardExpand(focused);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (focused.classList.contains('expanded')) {
          if (focused.classList.contains('insight-strip')) {
            focused.classList.remove('expanded');
          } else {
            toggleCardExpand(focused);
          }
        }
      }
    });

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

    // Now Watching bar (row 5)
    const nowWatchingBar = document.createElement('div');
    nowWatchingBar.id = 'ctx-now-watching';
    nowWatchingBar.className = 'ctx-now-watching';
    nowWatchingBar.innerHTML = `<span class="ctx-now-watching-label">NOW WATCHING</span><span class="ctx-now-watching-title"></span>`;
    cardsWrap.appendChild(nowWatchingBar);

    // Filter bar (row 6)
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
      const entityCards = cardContainer.querySelectorAll('.context-card');
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

    // Cards area wrapper (for new-cards pill overlay)
    const cardsArea = document.createElement('div');
    cardsArea.className = 'ctx-cards-area';
    cardsArea.appendChild(cardContainer);
    const newCardsPill = document.createElement('div');
    newCardsPill.className = 'new-cards-pill';
    newCardsPill.addEventListener('click', () => {
      cardContainer.scrollTo({ top: cardContainer.scrollHeight, behavior: 'smooth' });
      missedNewCards = 0;
      newCardsPill.classList.remove('visible');
    });
    cardsArea.appendChild(newCardsPill);
    cardsWrap.appendChild(cardsArea);

    // Scroll listener: detect when user reaches bottom → hide pill
    cardContainer.addEventListener('scroll', () => {
      const atBottom = cardContainer.scrollHeight - cardContainer.scrollTop - cardContainer.clientHeight < 100;
      if (atBottom && missedNewCards > 0) {
        missedNewCards = 0;
        newCardsPill.classList.remove('visible');
      }
    }, { passive: true });

    cardsWrap.appendChild(askResponse);
    cardsWrap.appendChild(suggestionsBar);
    cardsWrap.appendChild(askBar);
    sidebar.appendChild(cardsWrap);

    // Copy event tracking
    sidebar.addEventListener('copy', (e) => {
      const card = e.target.closest('.context-card, .insight-strip');
      if (card) {
        try { chrome.runtime.sendMessage({ type: 'CARD_COPY', term: card.dataset.term || 'unknown', entityType: card.dataset.entityType || 'unknown' }); } catch (err) {}
      }
    });

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

      const headingRow = document.createElement('div');
      headingRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0 0 8px 0;';
      const headingText = document.createElement('span');
      headingText.className = 'ctx-settings-heading';
      headingText.textContent = 'Settings';
      headingText.style.padding = '0';
      const closeX = document.createElement('button');
      closeX.textContent = '\u2715';
      closeX.style.cssText = 'background:none;border:none;color:var(--text-secondary);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:4px;';
      closeX.addEventListener('mouseenter', () => { closeX.style.color = 'var(--text-primary)'; });
      closeX.addEventListener('mouseleave', () => { closeX.style.color = 'var(--text-secondary)'; });
      closeX.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsPanel.classList.remove('open');
        settingsBtn.classList.remove('active');
      });
      headingRow.appendChild(headingText);
      headingRow.appendChild(closeX);
      settingsPanel.appendChild(headingRow);

      // Section 0: Account / Sign In
      const authSection = document.createElement('div');
      authSection.className = 'ctx-auth-section';
      function renderAuth(user) {
        authSection.innerHTML = '';
        if (user) {
          const profile = document.createElement('div');
          profile.className = 'ctx-auth-profile';
          if (user.picture) {
            const avatar = document.createElement('img');
            avatar.className = 'ctx-auth-avatar';
            avatar.src = user.picture;
            avatar.referrerPolicy = 'no-referrer';
            profile.appendChild(avatar);
          }
          const info = document.createElement('div');
          info.className = 'ctx-auth-info';
          const nameEl = document.createElement('div');
          nameEl.className = 'ctx-auth-name';
          nameEl.textContent = user.name || 'User';
          const plan = user.plan || 'free';
          const badge = document.createElement('span');
          badge.className = 'ctx-auth-badge ' + plan;
          badge.textContent = plan;
          nameEl.appendChild(badge);
          info.appendChild(nameEl);
          const emailEl = document.createElement('div');
          emailEl.className = 'ctx-auth-email';
          emailEl.textContent = user.email || '';
          info.appendChild(emailEl);
          profile.appendChild(info);
          authSection.appendChild(profile);
          const signOutBtn = document.createElement('button');
          signOutBtn.className = 'ctx-auth-signout';
          signOutBtn.textContent = 'Sign out';
          signOutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try { chrome.runtime.sendMessage({ type: 'GOOGLE_SIGN_OUT' }); } catch (err) {}
            renderAuth(null);
          });
          authSection.appendChild(signOutBtn);
        } else {
          const btn = document.createElement('button');
          btn.className = 'ctx-google-btn';
          btn.innerHTML = '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Sign in with Google';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.disabled = true;
            btn.style.opacity = '0.6';
            try { chrome.runtime.sendMessage({ type: 'GOOGLE_SIGN_IN' }); } catch (err) {}
          });
          authSection.appendChild(btn);
          const hint = document.createElement('div');
          hint.className = 'ctx-auth-hint';
          hint.textContent = 'Sync your settings and unlock unlimited usage';
          authSection.appendChild(hint);
        }
      }
      chrome.storage.local.get('user', (data) => renderAuth(data.user || null));
      authSection.addEventListener('auth-changed', (e) => renderAuth(e.detail));
      settingsPanel.appendChild(authSection);

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

      // Section 3b: Data & Privacy
      const s3b = document.createElement('div');
      s3b.className = 'ctx-settings-section';
      const s3bLabel = document.createElement('div');
      s3bLabel.className = 'ctx-settings-label';
      s3bLabel.textContent = 'Data & privacy';
      s3b.appendChild(s3bLabel);

      const consentRow = document.createElement('div');
      consentRow.className = 'ctx-settings-toggle-row';
      const consentLbl = document.createElement('span');
      consentLbl.className = 'ctx-settings-toggle-label';
      consentLbl.textContent = 'Help improve Context';
      const consentToggle = document.createElement('button');
      chrome.storage.local.get('dataConsent', (dc) => {
        consentToggle.className = 'ctx-settings-toggle' + (dc.dataConsent ? ' on' : '');
      });
      consentToggle.className = 'ctx-settings-toggle';
      consentToggle.addEventListener('click', () => {
        chrome.storage.local.get('dataConsent', (dc) => {
          const newVal = !dc.dataConsent;
          chrome.storage.local.set({ dataConsent: newVal });
          consentToggle.classList.toggle('on', newVal);
          try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'settings_change', properties: { dataConsent: newVal } }); } catch (e) {}
        });
      });
      consentRow.appendChild(consentLbl);
      consentRow.appendChild(consentToggle);
      s3b.appendChild(consentRow);

      const consentHint = document.createElement('div');
      consentHint.style.cssText = 'font-size:11px;color:#64748b;line-height:1.4;margin-top:4px;padding-left:2px;';
      consentHint.textContent = 'Anonymized session data helps us improve entity extraction and build better features. No personal data is shared.';
      s3b.appendChild(consentHint);
      settingsPanel.appendChild(s3b);

      // Section 4: Keyboard Shortcuts
      const s4 = document.createElement('div');
      s4.className = 'ctx-settings-section';
      const s4Label = document.createElement('div');
      s4Label.className = 'ctx-settings-label';
      s4Label.textContent = 'Keyboard shortcuts';
      s4.appendChild(s4Label);
      [
        ['Alt+Shift+X', 'Toggle sidebar'],
        ['Alt+Shift+S', 'Start / stop capture'],
        ['Alt+Shift+C', 'Copy study guide']
      ].forEach(([combo, desc]) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;';
        const kbd = document.createElement('span');
        kbd.style.cssText = 'background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 6px;font-size:11px;color:#e0e0f0;font-family:monospace;';
        kbd.textContent = combo;
        const label = document.createElement('span');
        label.style.cssText = 'font-size:11px;color:#64748b;';
        label.textContent = desc;
        row.appendChild(kbd);
        row.appendChild(label);
        s4.appendChild(row);
      });
      settingsPanel.appendChild(s4);

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
      try { chrome.runtime.sendMessage({ type: 'TRACK_EVENT', eventName: 'settings_change', properties: { knowledgeLevel: userSettings.knowledgeLevel, interests_count: (userSettings.interests || []).length } }); } catch (e) {}
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

    const FOLDER_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

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

      // Folder bar
      const folderBar = document.createElement('div');
      folderBar.className = 'folder-bar';
      historyPanel.appendChild(folderBar);

      const list = document.createElement('div');
      list.className = 'ctx-history-list';
      historyPanel.appendChild(list);

      let activeFolder = 'all';

      chrome.storage.local.get(['pastSessions', 'sessionFolders'], (data) => {
        const sessions = data.pastSessions || [];
        const folders = data.sessionFolders || [];

        // Build folder bar
        function renderFolderBar() {
          folderBar.innerHTML = '';
          const allChip = document.createElement('button');
          allChip.className = 'folder-chip' + (activeFolder === 'all' ? ' active' : '');
          allChip.textContent = 'All';
          allChip.addEventListener('click', (e) => { e.stopPropagation(); activeFolder = 'all'; renderFolderBar(); renderSessionList(); });
          folderBar.appendChild(allChip);

          folders.forEach(folder => {
            const chip = document.createElement('button');
            chip.className = 'folder-chip' + (activeFolder === folder.id ? ' active' : '');
            chip.textContent = folder.name;
            chip.style.borderColor = activeFolder === folder.id ? folder.color : '';
            if (activeFolder === folder.id) chip.style.background = folder.color;
            chip.addEventListener('click', (e) => { e.stopPropagation(); activeFolder = folder.id; renderFolderBar(); renderSessionList(); });
            folderBar.appendChild(chip);
          });

          const addBtn = document.createElement('button');
          addBtn.className = 'folder-add';
          addBtn.textContent = '+ New';
          addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const createDiv = document.createElement('div');
            createDiv.className = 'folder-create';
            const input = document.createElement('input');
            input.className = 'folder-name-input';
            input.type = 'text';
            input.placeholder = 'Folder name...';
            input.maxLength = 30;
            const saveBtn = document.createElement('button');
            saveBtn.className = 'folder-save';
            saveBtn.textContent = '\u2713';
            function doSave() {
              const name = input.value.trim();
              if (!name) return;
              const color = FOLDER_COLORS[folders.length % FOLDER_COLORS.length];
              const newFolder = { id: 'f' + Date.now(), name, color, sessionIds: [] };
              folders.push(newFolder);
              chrome.storage.local.set({ sessionFolders: folders });
              renderFolderBar();
            }
            saveBtn.addEventListener('click', (ev) => { ev.stopPropagation(); doSave(); });
            input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); doSave(); } if (ev.key === 'Escape') { ev.stopPropagation(); renderFolderBar(); } });
            createDiv.appendChild(input);
            createDiv.appendChild(saveBtn);
            addBtn.replaceWith(createDiv);
            input.focus();
          });
          folderBar.appendChild(addBtn);
        }

        function getFolderForSession(sessionId) {
          return folders.find(f => f.sessionIds.includes(sessionId)) || null;
        }

        function renderSessionList() {
          list.innerHTML = '';
          const filtered = activeFolder === 'all'
            ? sessions
            : sessions.filter(s => {
                const folder = folders.find(f => f.id === activeFolder);
                return folder && folder.sessionIds.includes(s.id);
              });

          if (filtered.length === 0) {
            list.innerHTML = '<div class="ctx-history-empty">No sessions in this view.</div>';
            return;
          }

          filtered.forEach(session => {
            const item = document.createElement('div');
            item.className = 'ctx-history-item';
            item.dataset.sessionId = String(session.id);

            const chevron = document.createElement('span');
            chevron.className = 'ctx-history-item-chevron';
            chevron.textContent = '\u203A';

            const titleDiv = document.createElement('div');
            titleDiv.className = 'ctx-history-item-title';
            const sessionFolder = getFolderForSession(session.id);
            if (sessionFolder) {
              const dot = document.createElement('span');
              dot.className = 'session-folder-dot';
              dot.style.background = sessionFolder.color;
              titleDiv.appendChild(dot);
            }
            titleDiv.appendChild(document.createTextNode(session.title || 'Untitled'));
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

            // Folder assign button
            const folderBtn = document.createElement('button');
            folderBtn.className = 'session-folder-btn';
            folderBtn.textContent = '\uD83D\uDCC1';
            folderBtn.title = 'Move to folder';
            folderBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              // Remove any existing dropdown
              const existing = item.querySelector('.session-folder-dropdown');
              if (existing) { existing.remove(); return; }
              const dropdown = document.createElement('div');
              dropdown.className = 'session-folder-dropdown';
              // "None" option
              const noneOpt = document.createElement('button');
              noneOpt.className = 'session-folder-dropdown-item' + (!sessionFolder ? ' active' : '');
              noneOpt.textContent = 'None';
              noneOpt.addEventListener('click', (ev) => {
                ev.stopPropagation();
                folders.forEach(f => { f.sessionIds = f.sessionIds.filter(id => id !== session.id); });
                chrome.storage.local.set({ sessionFolders: folders });
                dropdown.remove();
                renderSessionList();
              });
              dropdown.appendChild(noneOpt);
              folders.forEach(f => {
                const opt = document.createElement('button');
                opt.className = 'session-folder-dropdown-item' + (sessionFolder && sessionFolder.id === f.id ? ' active' : '');
                const colorDot = document.createElement('span');
                colorDot.className = 'session-folder-dot';
                colorDot.style.background = f.color;
                opt.appendChild(colorDot);
                opt.appendChild(document.createTextNode(f.name));
                opt.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  // Remove from all folders first
                  folders.forEach(ff => { ff.sessionIds = ff.sessionIds.filter(id => id !== session.id); });
                  f.sessionIds.push(session.id);
                  chrome.storage.local.set({ sessionFolders: folders });
                  dropdown.remove();
                  renderSessionList();
                });
                dropdown.appendChild(opt);
              });
              item.appendChild(dropdown);
              // Close on outside click
              const closeDropdown = (ev) => {
                if (!dropdown.contains(ev.target)) { dropdown.remove(); document.removeEventListener('click', closeDropdown, true); }
              };
              setTimeout(() => document.addEventListener('click', closeDropdown, true), 0);
            });

            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'session-delete';
            deleteBtn.textContent = '\u00D7';
            deleteBtn.title = 'Delete session';
            deleteBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const sid = String(session.id);
              const idx = sessions.findIndex(s => String(s.id) === sid);
              if (idx !== -1) sessions.splice(idx, 1);
              folders.forEach(f => { f.sessionIds = f.sessionIds.filter(id => String(id) !== sid); });
              chrome.storage.local.set({ pastSessions: sessions, sessionFolders: folders });
              item.remove();
              if (list.children.length === 0) {
                list.innerHTML = '<div class="ctx-history-empty">No sessions in this view.</div>';
              }
            });

            item.appendChild(titleDiv);
            item.appendChild(meta);
            item.appendChild(detail);
            item.appendChild(folderBtn);
            item.appendChild(deleteBtn);

            item.addEventListener('click', (ev) => {
              if (ev.target.closest('.session-delete') || ev.target.closest('.session-folder-btn') || ev.target.closest('.session-folder-dropdown')) return;
              const wasExpanded = item.classList.contains('expanded');
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

        renderFolderBar();
        renderSessionList();
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
          chrome.storage.local.remove(['pastSessions', 'sessionFolders']);
          list.innerHTML = '<div class="ctx-history-empty">No past sessions yet.<br>Sessions are saved when you clear the sidebar.</div>';
          folderBar.innerHTML = '';
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

      if (entities.length > 0 || insights.length > 0) {
        // Export buttons row — insert at top
        function buildSessionGuide(sess) {
          const ents = sess.entities || [];
          const ins = sess.insights || [];
          let guide = '# Study Guide: ' + (sess.title || 'Untitled') + '\n\n';
          if (ents.length > 0) {
            guide += '## Entities\n';
            ents.forEach(e => {
              guide += '- **' + (e.term || '') + '** (' + (e.type || '') + ')' + (e.description ? ' \u2014 ' + e.description : '') + '\n';
            });
            guide += '\n';
          }
          if (ins.length > 0) {
            guide += '## Insights\n';
            ins.forEach(i => {
              const label = i.term || i.insight || '';
              const detail = i.description || i.detail || '';
              guide += '- \uD83D\uDCA1 **' + label + '**' + (detail ? ' \u2014 ' + detail : '') + '\n';
            });
            guide += '\n';
          }
          guide += '---\nGenerated with Context \u2014 a live AI study guide for any video\nhttps://chromewebstore.google.com/detail/context/' + chrome.runtime.id;
          return guide;
        }

        const exportRow = document.createElement('div');
        exportRow.className = 'ctx-history-export-row';

        const copyBtn = document.createElement('button');
        copyBtn.className = 'ctx-history-export-btn';
        copyBtn.textContent = 'Copy to clipboard';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = buildSessionGuide(session);
          copyToClipboard(text).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 1500);
          });
        });

        const dlBtn = document.createElement('button');
        dlBtn.className = 'ctx-history-export-btn';
        dlBtn.textContent = 'Download .txt';
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = buildSessionGuide(session);
          const blob = new Blob([text], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = (session.title || 'study-guide').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.txt';
          a.click();
          URL.revokeObjectURL(url);
          dlBtn.textContent = 'Downloaded!';
          setTimeout(() => { dlBtn.textContent = 'Download .txt'; }, 1500);
        });

        exportRow.appendChild(copyBtn);
        exportRow.appendChild(dlBtn);
        container.appendChild(exportRow);
      }

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

    // Usage footer
    const usageFooter = document.createElement('div');
    usageFooter.className = 'ctx-usage-footer';
    usageFooter.id = 'ctx-usage-footer';
    usageFooter.style.display = 'none';
    sidebar.appendChild(usageFooter);
    // Load initial usage
    chrome.storage.local.get(['usageToday', 'user', 'analytics'], (data) => {
      const user = data.user;
      if (user && user.plan === 'pro') return; // Pro users — no footer
      const installDate = (data.analytics || {}).installDate || Date.now();
      if ((Date.now() - installDate) / (1000 * 60 * 60 * 24) < 3) return; // Trial — no footer
      const today = new Date().toISOString().split('T')[0];
      const usage = data.usageToday || { date: today, minutes: 0 };
      if (usage.date === today && usage.minutes > 0) {
        usageFooter.textContent = usage.minutes + '/30 min';
        usageFooter.style.display = '';
      }
    });

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

    // Floating widget (visible when sidebar closed + capturing active)
    const floatingWidget = document.createElement('div');
    floatingWidget.className = 'floating-widget';
    floatingWidget.innerHTML = '<div class="widget-dot"></div><span class="widget-count">0</span>';
    floatingWidget.addEventListener('click', () => {
      openSidebar();
      resetAutoHide();
    });
    shadowRoot.appendChild(floatingWidget);

    shadowRoot.appendChild(sidebar);
    document.body.appendChild(hostEl);

    ensureBadge();
    applyTheme();
    // Clear NEW badge on first sidebar creation
    chrome.runtime.sendMessage({ type: 'SIDEBAR_FIRST_OPEN' }).catch(() => {});
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


      // Sync floating widget with initial state
      updateFloatingWidget(!!data.capturing);
    });

    // Restore Now Watching bar on page refresh — read document.title directly
    chrome.storage.local.get('capturing', (data) => {
      if (data.capturing) {
        const bar = shadowRoot?.getElementById('ctx-now-watching');
        if (bar) {
          const title = document.title.replace(/\s*-\s*YouTube$/i, '').replace(/^\(\d+\)\s*/, '').trim();
          if (title && title !== 'YouTube') {
            bar.querySelector('.ctx-now-watching-title').textContent = title;
            bar.classList.add('visible');
          }
        }
      }
    });

    // Watch for title changes to keep Now Watching bar current (YouTube SPA updates title dynamically)
    const titleObserver = new MutationObserver(() => {
      const bar = shadowRoot?.getElementById('ctx-now-watching');
      if (bar && bar.classList.contains('visible')) {
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
    // Clear progressive loading timeouts — first card has arrived
    clearTimeout(loadingTimeout5); clearTimeout(loadingTimeout15); clearTimeout(loadingTimeout30);
    loadingTimeout5 = loadingTimeout15 = loadingTimeout30 = null;
    const empty = shadowRoot.getElementById('empty-state');
    const cards = shadowRoot.getElementById('cards');
    // Fade out transcript ticker
    const ticker = empty ? empty.querySelector('.transcript-ticker') : null;
    if (ticker) ticker.classList.add('hidden');
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
    // Send session metrics before resetting
    if (cardsRenderedThisSession > 0) {
      try {
        chrome.runtime.sendMessage({
          type: 'SESSION_METRICS',
          cardsRendered: cardsRenderedThisSession,
          cardsExpanded: cardsExpandedThisSession,
          expansionRate: cardsRenderedThisSession > 0 ? (cardsExpandedThisSession / cardsRenderedThisSession).toFixed(2) : '0'
        });
      } catch (e) {}
    }
    cardsRenderedThisSession = 0;
    cardsExpandedThisSession = 0;
    hasCards = false;
    termCount = 0;
    seenTerms.clear();
    lastRenderedTerm = '';
    missedNewCards = 0;
    lastDividerTime = 0;
    resetVirtualScroll();
    if (askIdleTimer) { clearTimeout(askIdleTimer); askIdleTimer = null; }
    if (listeningTimer) { clearTimeout(listeningTimer); listeningTimer = null; }

    if (shadowRoot) {
      const cards = shadowRoot.getElementById('cards');
      if (cards) {
        cards.innerHTML = '';
        cards.style.display = 'none';
      }
      // Remove usage warning banner
      const usageWarning = shadowRoot.querySelector('.ctx-usage-warning');
      if (usageWarning) usageWarning.remove();
      const empty = shadowRoot.getElementById('empty-state');
      if (empty) {
        empty.style.display = '';
        empty.style.opacity = '1';
        const emptyText = empty.querySelector('.ctx-empty-text');
        if (emptyText) { emptyText.style.display = ''; emptyText.textContent = 'Listening for context...'; }
        const ticker = empty.querySelector('.transcript-ticker');
        if (ticker) ticker.classList.add('hidden');
        const waveform = empty.querySelector('.ctx-waveform');
        if (waveform) waveform.style.display = '';
        const returningDiv = empty.querySelector('.empty-state-returning');
        if (returningDiv) returningDiv.style.display = 'none';
      }
      const li = shadowRoot.getElementById('listening-indicator');
      if (li) li.classList.remove('visible');
      // Clear any session summary
      const summary = shadowRoot.querySelector('.ctx-session-summary');
      if (summary) summary.remove();
      // Reset new-cards pill
      const pill = shadowRoot.querySelector('.new-cards-pill');
      if (pill) pill.classList.remove('visible');
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
    if (vcard.type === 'divider' || vcard.type === 'time-divider') return HEIGHT_DIVIDER;
    if (vcard.type === 'insight') return HEIGHT_INSIGHT;
    return HEIGHT_COLLAPSED;
  }

  function isCardFiltered(vcard, cardsEl) {
    if (!cardsEl) return false;
    if (vcard.type === 'divider' || vcard.type === 'time-divider') return false;
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
    const existingCards = cardsEl.querySelectorAll('.context-card, .ctx-video-divider, .insight-strip, .time-divider');
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
    if (vc.type === 'time-divider') {
      const d = document.createElement('div');
      d.className = 'time-divider';
      d.innerHTML = '<span class="time-divider-line"></span><span class="time-divider-label">' + escapeHtml(vc.data.label || '') + '</span><span class="time-divider-line"></span>';
      return d;
    }
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
      const existing = cardsEl.querySelectorAll('.context-card, .ctx-video-divider, .insight-strip, .time-divider');
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
    if (el.classList.contains('time-divider')) {
      const label = el.querySelector('.time-divider-label')?.textContent || '';
      return { data: { type: 'time-divider', label }, height: h, measuredHeight: h, type: 'time-divider', el: null, dismissed: false, highlighted: false };
    }
    const isInsight = el.classList.contains('insight-strip');
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

  function addVirtualCard(vc, cardsEl) {
    virtualCards.push(vc);

    if (!virtualActive && virtualCards.length > VIRTUAL_THRESHOLD) {
      activateVirtualScroll(cardsEl);
      return;
    }

    if (virtualActive) {
      const atBottom = cardsEl.scrollHeight - cardsEl.scrollTop - cardsEl.clientHeight < 100;
      virtualRenderedRange = { start: -1, end: -1 };
      virtualScrollRender(cardsEl);
      if (atBottom) {
        requestAnimationFrame(() => { cardsEl.scrollTop = cardsEl.scrollHeight; });
      } else {
        missedNewCards++;
        updateNewCardsPill();
      }
    }
  }

  function resetVirtualScroll() {
    virtualCards = [];
    virtualActive = false;
    virtualRenderedRange = { start: -1, end: -1 };
    if (virtualScrollRAF) { cancelAnimationFrame(virtualScrollRAF); virtualScrollRAF = null; }
  }

  function updateNewCardsPill() {
    if (!shadowRoot) return;
    const pill = shadowRoot.querySelector('.new-cards-pill');
    if (!pill) return;
    if (missedNewCards > 0) {
      pill.textContent = '\u2193 ' + missedNewCards + ' new card' + (missedNewCards !== 1 ? 's' : '');
      pill.classList.add('visible');
    } else {
      pill.classList.remove('visible');
    }
  }

  function maybeInsertTimeDivider(cardsEl) {
    if (!lastDividerTime) {
      lastDividerTime = lastSessionStart || Date.now();
      return;
    }
    const now = Date.now();
    if (now - lastDividerTime < 120000) return;
    const elapsed = now - (lastSessionStart || now);
    const totalSec = Math.floor(elapsed / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const label = min + ':' + (sec < 10 ? '0' : '') + sec;

    if (virtualActive) {
      virtualCards.push({ data: { type: 'time-divider', label }, height: HEIGHT_DIVIDER, measuredHeight: 0, type: 'time-divider', el: null, dismissed: false, highlighted: false });
    } else {
      const divider = document.createElement('div');
      divider.className = 'time-divider';
      divider.innerHTML = '<span class="time-divider-line"></span><span class="time-divider-label">' + escapeHtml(label) + '</span><span class="time-divider-line"></span>';
      cardsEl.appendChild(divider);
      virtualCards.push({ data: { type: 'time-divider', label }, height: HEIGHT_DIVIDER, measuredHeight: 0, type: 'time-divider', el: divider, dismissed: false, highlighted: false });
    }
    lastDividerTime = now;
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
    const isFirstCards = !hasCards;
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

    // Score and sort entities by relevance
    const scored = limited.map(e => ({ ...e, _score: computeCardScore(e) }));
    scored.sort((a, b) => b._score - a._score);

    // Check if user is at bottom before insertion (always true for first cards)
    const wasAtBottom = isFirstCards || cards.scrollHeight - cards.scrollTop - cards.clientHeight < 100;

    // Insert time divider if enough time has passed
    maybeInsertTimeDivider(cards);

    let autoExpandCount = 0;
    scored.forEach(entity => {
      const vcType = entity.type === 'stock' ? 'stock' : 'entity';
      const vc = { data: entity, height: HEIGHT_COLLAPSED, measuredHeight: 0, type: vcType, el: null, dismissed: false, highlighted: false };

      if (virtualActive) {
        addVirtualCard(vc, cards);
      } else {
        const card = entity.type === 'stock'
          ? createStockCard(entity)
          : createGenericCard(entity);
        card.dataset.createdAt = Date.now().toString();

        // High-relevance visual indicator
        if (entity._score > 0.75) {
          card.classList.add('high-relevance');
        }

        // Auto-expand highest-score cards (max 2 per batch)
        if (entity._score > 0.85 && autoExpandCount < 2) {
          card.classList.add('expanded');
          card.dataset.expandedAt = Date.now().toString();
          card.dataset.wasExpanded = 'true';
          cardsExpandedThisSession++;
          autoExpandCount++;
          vc.height = HEIGHT_EXPANDED;
        }

        cards.appendChild(card);
        vc.el = card;
        virtualCards.push(vc);

        // Check if we should activate virtual scrolling
        if (virtualCards.length > VIRTUAL_THRESHOLD) {
          activateVirtualScroll(cards);
        }
      }
      termCount++;
      cardsRenderedThisSession++;
      console.log('[CONTENT] Card added:', entity.ticker || entity.term || entity.name, 'score:', entity._score.toFixed(2));
    });

    // Auto-scroll to bottom or show new-cards pill
    if (wasAtBottom) {
      requestAnimationFrame(() => { cards.scrollTop = cards.scrollHeight; });
    } else if (!virtualActive) {
      missedNewCards += scored.length;
      updateNewCardsPill();
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

        // Feed transcript ticker in empty state
        if (!hasCards) {
          const ticker = shadowRoot.querySelector('.transcript-ticker');
          const tickerText = ticker ? ticker.querySelector('.ticker-text') : null;
          if (tickerText && text.length > 0) {
            tickerText.textContent = text.slice(-100);
            ticker.classList.remove('hidden');
            // Hide static text once real transcript flows — proves the product is working
            const emptyText = shadowRoot.querySelector('.ctx-empty-text');
            if (emptyText) emptyText.style.display = 'none';
          }
        }

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

          cards.appendChild(divider);
        }
      });
    }
    if (changes.capturing) {
      const btn = shadowRoot?.getElementById('ctx-listen-btn');
      if (changes.capturing.newValue === true) {
        ensureBadge();
        setBadgeCapturing(true, false);
        if (btn) { btn.textContent = '\u25A0'; btn.title = 'Stop Recording'; btn.classList.add('listening'); }
        const liveDot = shadowRoot?.querySelector('.ctx-live-dot');
        if (liveDot) liveDot.classList.add('active');
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
              bar.classList.add('visible');
            }
          }
        }
        // Progressive loading messages while waiting for first card
        clearTimeout(loadingTimeout5); clearTimeout(loadingTimeout15); clearTimeout(loadingTimeout30);
        loadingTimeout5 = setTimeout(() => {
          if (!hasCards) {
            const et = shadowRoot?.querySelector('.ctx-empty-text');
            if (et && et.style.display !== 'none') et.textContent = 'Processing audio...';
          }
        }, 5000);
        loadingTimeout15 = setTimeout(() => {
          if (!hasCards) {
            const et = shadowRoot?.querySelector('.ctx-empty-text');
            if (et && et.style.display !== 'none') et.textContent = 'Analyzing... cards will appear as terms are detected.';
          }
        }, 15000);
        loadingTimeout30 = setTimeout(() => {
          if (!hasCards) {
            const et = shadowRoot?.querySelector('.ctx-empty-text');
            if (et && et.style.display !== 'none') et.textContent = 'Still listening. If you don\'t hear audio, try refreshing the page.';
          }
        }, 30000);
      } else if (changes.capturing.newValue === false) {
        setBadgeCapturing(false, false);
        if (btn) { btn.textContent = '\u25B6'; btn.title = 'Start Listening'; btn.classList.remove('listening'); }
        const liveDot = shadowRoot?.querySelector('.ctx-live-dot');
        if (liveDot) liveDot.classList.remove('active');
        // Hide Now Watching bar
        const nwBar = shadowRoot?.getElementById('ctx-now-watching');
        if (nwBar) nwBar.classList.remove('visible');
        // Clear progressive loading timeouts
        clearTimeout(loadingTimeout5); clearTimeout(loadingTimeout15); clearTimeout(loadingTimeout30);
        loadingTimeout5 = loadingTimeout15 = loadingTimeout30 = null;
      }
    }
    if (changes.capturing && changes.capturing.oldValue === true && changes.capturing.newValue === false) {
      isActiveTab((active) => {
        if (!active) return;
        chrome.storage.local.get(['sessionHistory', 'knowledgeBase', 'capturingTabTitle', 'cardReactions', 'sessionQA', 'sessionStats', 'sessionCount', 'analytics'], (data) => {
          const history = data.sessionHistory || [];
          const kb = data.knowledgeBase || {};
          const title = data.capturingTabTitle || document.title || 'Untitled Video';
          const summaryReactions = data.cardReactions || {};
          const summaryQA = data.sessionQA || [];
          const stats = data.sessionStats || {};
          const sessionCount = data.sessionCount || 1;
          const analyticsData = data.analytics || {};

          const totalEntities = stats.totalEntities || history.filter(h => h.term && h.type !== 'insight').length;
          const totalInsights = stats.totalInsights || history.filter(h => h.type === 'insight').length;
          const dominantTopic = stats.dominantTopic || 'general';
          const topicBreakdown = stats.topicBreakdown || {};
          const kbSize = stats.knowledgeBaseSize || Object.keys(kb).length;

          // Build topic breakdown string with percentages
          const totalTopicCount = Object.values(topicBreakdown).reduce((a, b) => a + b, 0) || 1;
          const topicParts = Object.entries(topicBreakdown)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([topic, count]) => {
              const pct = Math.round((count / totalTopicCount) * 100);
              const label = topic.charAt(0).toUpperCase() + topic.slice(1);
              return label + ' ' + pct + '%';
            });
          const topicLine = topicParts.length > 0 ? topicParts.join(' \u00B7 ') : '';

          const dominantLabel = dominantTopic.charAt(0).toUpperCase() + dominantTopic.slice(1);

          const cardsContainer = shadowRoot ? shadowRoot.getElementById('cards') : null;
          if (!cardsContainer) return;

          // Remove any existing summary
          const existing = cardsContainer.querySelector('.ctx-session-summary');
          if (existing) existing.remove();

          const summaryEl = document.createElement('div');
          summaryEl.className = 'ctx-session-summary';
          const isFirstSession = (analyticsData.totalSessions || 0) <= 1;
          const showExportPrompt = isFirstSession && totalEntities >= 5;

          summaryEl.innerHTML = `
            <div class="ctx-session-summary-header">Session Complete \u2713</div>
            <div class="ctx-session-summary-headline"><strong>${totalEntities} terms</strong> \u00B7 <strong>${totalInsights} insights</strong> \u00B7 Dominant topic: <strong>${escapeHtml(dominantLabel)}</strong></div>
            ${topicLine ? `<div class="ctx-session-summary-topics">${escapeHtml(topicLine)}</div>` : ''}
            <div class="ctx-session-summary-kb">Your knowledge base: ${kbSize} total terms across ${sessionCount} session${sessionCount !== 1 ? 's' : ''}</div>
            ${showExportPrompt ? `<div class="ctx-session-summary-export-prompt">You just learned ${totalEntities} new terms. Save them as a study guide?</div>` : ''}
            <div class="ctx-session-summary-actions">
              <button class="ctx-session-summary-export">${showExportPrompt ? '\u2B07 Export Study Guide' : 'Export Study Guide'}</button>
              <button class="ctx-session-summary-viewkb">View Knowledge Base</button>
            </div>
            <button class="ctx-session-summary-dismiss">Dismiss</button>
          `;

          summaryEl.querySelector('.ctx-session-summary-export').addEventListener('click', (e) => {
            e.stopPropagation();
            const guide = generateStudyGuide(title, history, kb, window.location.href, summaryReactions, summaryQA);
            copyToClipboard(guide).then(() => {
              const btn = summaryEl.querySelector('.ctx-session-summary-export');
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Export Study Guide'; }, 1500);
            });
          });

          summaryEl.querySelector('.ctx-session-summary-viewkb').addEventListener('click', (e) => {
            e.stopPropagation();
            const historyBtn = shadowRoot.querySelector('.ctx-history-btn');
            if (historyBtn) historyBtn.click();
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
                  cardsRenderedThisSession++;
                  if (virtualActive) {
                    addVirtualCard(vc, cards);
                  } else {
                    const card = createInsightCard(insight);
                    card.dataset.createdAt = Date.now().toString();
                    cards.appendChild(card);
                    vc.el = card;
                    virtualCards.push(vc);
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
    // Patch late-arriving thumbnails onto existing cards
    if (changes.sessionHistory && shadowRoot) {
      const history = changes.sessionHistory.newValue || [];
      history.forEach(item => {
        if (item.thumbnail && item.term) {
          const cards = shadowRoot.querySelectorAll('.context-card');
          cards.forEach(card => {
            if (card.dataset.term === item.term && !card.querySelector('.card-thumb')) {
              const expandArea = card.querySelector('.card-expand-area');
              if (expandArea) {
                const img = document.createElement('img');
                img.className = 'card-thumb';
                img.src = item.thumbnail;
                img.alt = '';
                expandArea.insertBefore(img, expandArea.firstChild);
              }
              card.dataset.thumbUrl = item.thumbnail;
            }
          });
        }
      });
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
          cards.appendChild(card);
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
                cards.appendChild(card);
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
      const lastChild = cards.lastElementChild;
      if (lastChild && lastChild.classList.contains('ctx-video-divider')) return;

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
      cards.appendChild(divider);
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

  // --- Video pause detector: snapshot session after 30s paused ---
  let pauseTimer = null;
  function setupPauseDetector() {
    const video = document.querySelector('video');
    if (!video || video.__ctxPauseDetector) return;
    video.__ctxPauseDetector = true;
    video.addEventListener('pause', () => {
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        try { chrome.runtime.sendMessage({ type: 'VIDEO_PAUSED_LONG' }); } catch (e) {}
      }, 30000);
    });
    video.addEventListener('play', () => {
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    });
  }
  setupPauseDetector();
  document.addEventListener('yt-navigate-finish', () => setTimeout(setupPauseDetector, 1000));

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
          bar.classList.add('visible');
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
    if (msg.type === 'OPEN_SIDEBAR') {
      ensureSidebar();
      openSidebar();
    } else if (msg.type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
    } else if (msg.type === 'CAPTURE_STATE') {
      const btn = shadowRoot?.getElementById('ctx-listen-btn');
      if (btn) {
        if (msg.capturing) {
          btn.textContent = '\u25A0'; btn.title = 'Stop Recording';
          btn.classList.add('listening');
          // Reset counters for new session
          cardsRenderedThisSession = 0;
          cardsExpandedThisSession = 0;
        } else {
          btn.textContent = '\u25B6'; btn.title = 'Start Listening';
          btn.classList.remove('listening');
          // Send session metrics on stop
          try {
            chrome.runtime.sendMessage({
              type: 'SESSION_METRICS',
              cardsRendered: cardsRenderedThisSession,
              cardsExpanded: cardsExpandedThisSession,
              expansionRate: cardsRenderedThisSession > 0 ? (cardsExpandedThisSession / cardsRenderedThisSession).toFixed(2) : '0'
            });
          } catch (e) {}
        }
      }
      updateFloatingWidget(msg.capturing);
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
        text.innerHTML = 'Connection failed. Try stopping and restarting.<br><span style="opacity:0.7;font-size:10px;">Still trying\u2026 your audio is still playing normally.</span>';
      } else {
        bar.className = 'ctx-status-bar visible warning';
        icon.textContent = '\u26A0';
        text.innerHTML = escapeHtml(name) + ' connection lost, retrying\u2026<br><span style="opacity:0.7;font-size:10px;">Still trying\u2026 your audio is still playing normally.</span>';
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
    } else if (msg.type === 'USAGE_UPDATE') {
      if (!shadowRoot) return;
      const footer = shadowRoot.getElementById('ctx-usage-footer');
      if (footer) {
        footer.textContent = (msg.minutes || 0) + '/30 min';
        footer.style.display = '';
      }
    } else if (msg.type === 'USAGE_WARNING') {
      if (!shadowRoot) return;
      if (shadowRoot.querySelector('.ctx-usage-warning')) return; // already showing
      const cards = shadowRoot.getElementById('cards');
      if (!cards) return;
      const banner = document.createElement('div');
      banner.className = 'ctx-usage-warning';
      banner.innerHTML = (msg.minutesLeft || 5) + ' minutes remaining today. <span class="upgrade-link">Upgrade for unlimited \u2192</span>';
      banner.querySelector('.upgrade-link').addEventListener('click', () => {
        banner.textContent = 'Pro plan coming soon!';
      });
      cards.parentNode.insertBefore(banner, cards);
    } else if (msg.type === 'USAGE_LIMIT_REACHED') {
      if (!shadowRoot) return;
      // Update listen button to idle state
      const btn = shadowRoot.getElementById('ctx-listen-btn');
      if (btn) { btn.textContent = '\u25B6'; btn.title = 'Start Listening'; btn.classList.remove('listening'); }
      // Remove existing overlay if any
      const existing = shadowRoot.querySelector('.ctx-usage-limit');
      if (existing) existing.remove();
      // Show usage limit overlay
      const overlay = document.createElement('div');
      overlay.className = 'ctx-usage-limit';
      // Calculate time until midnight reset (live-ticking)
      function calcResetText() {
        const n = new Date();
        const mid = new Date(n);
        mid.setHours(24, 0, 0, 0);
        const diff = mid - n;
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        return 'Resets in ' + h + 'h ' + m + 'm';
      }
      overlay.innerHTML = '<div class="ctx-usage-limit-title">Free limit reached</div>' +
        '<div class="ctx-usage-limit-meter">' + (msg.minutes || 30) + ' minutes used today</div>' +
        '<div class="ctx-usage-limit-body">You\'ve used your 30 free minutes for today.</div>' +
        '<div class="ctx-usage-countdown">' + calcResetText() + '</div>' +
        '<button class="ctx-usage-limit-upgrade">Upgrade to Pro \u2014 $9/mo</button>' +
        '<button class="ctx-usage-limit-dismiss">Dismiss</button>';
      // Live-tick the countdown every 60s
      const countdownEl = overlay.querySelector('.ctx-usage-countdown');
      const countdownInterval = setInterval(() => {
        if (!overlay.isConnected) { clearInterval(countdownInterval); return; }
        countdownEl.textContent = calcResetText();
      }, 60000);
      overlay.querySelector('.ctx-usage-limit-upgrade').addEventListener('click', () => {
        // Billing not built yet — show coming soon feedback
        const upgradeBtn = overlay.querySelector('.ctx-usage-limit-upgrade');
        if (upgradeBtn) { upgradeBtn.textContent = 'Coming soon!'; upgradeBtn.disabled = true; }
      });
      overlay.querySelector('.ctx-usage-limit-dismiss').addEventListener('click', () => {
        clearInterval(countdownInterval);
        overlay.remove();
      });
      const sidebar = shadowRoot.getElementById('sidebar');
      if (sidebar) sidebar.appendChild(overlay);
    } else if (msg.type === 'SIGN_IN_SUCCESS') {
      // Re-render auth section in settings if open
      if (!shadowRoot) return;
      const authEl = shadowRoot.querySelector('.ctx-auth-section');
      if (authEl) {
        chrome.storage.local.get('user', (data) => {
          if (data.user) {
            // Trigger settings rebuild to update auth section
            const panel = shadowRoot.querySelector('.ctx-settings-panel');
            if (panel && panel.classList.contains('open')) {
              // Dispatch a synthetic rebuild
              authEl.dispatchEvent(new CustomEvent('auth-changed', { detail: data.user }));
            }
          }
        });
      }
    } else if (msg.type === 'SIGN_OUT_SUCCESS') {
      if (!shadowRoot) return;
      const authEl = shadowRoot.querySelector('.ctx-auth-section');
      if (authEl) {
        authEl.dispatchEvent(new CustomEvent('auth-changed', { detail: null }));
      }
    } else if (msg.type === 'THUMBNAIL_UPDATE') {
      if (!shadowRoot) return;
      const term = (msg.term || '').toLowerCase();
      const thumb = msg.thumbnail;
      if (!term || !thumb) return;
      const cards = shadowRoot.querySelectorAll('.context-card');
      for (const card of cards) {
        const cardTerm = (card.dataset.term || '').toLowerCase();
        if (cardTerm === term) {
          card.dataset.thumbUrl = thumb;
          break;
        }
      }
    } else if (msg.type === 'ENTITY_REMENTION') {
      if (!shadowRoot) return;
      const term = (msg.term || '').toLowerCase();
      if (!term) return;
      const cards = shadowRoot.querySelectorAll('.context-card');
      for (const card of cards) {
        const cardTerm = (card.dataset.term || '').toLowerCase();
        if (cardTerm === term) {
          card.classList.remove('remention');
          void card.offsetWidth; // force reflow to restart animation
          card.classList.add('remention');
          setTimeout(() => card.classList.remove('remention'), 800);
          break;
        }
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
