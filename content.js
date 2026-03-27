(() => {
  const DEDUP_WINDOW_MS = 600000; // 10 minutes
  const recentTerms = new Map(); // term -> timestamp

  let host = null;
  let shadowRoot = null;
  let sidebar = null;
  let cardContainer = null;
  let ignoreList = new Set();
  let settings = {
    cardsPerChunk: 3,
    autoHide: false
  };
  let autoHideTimer = null;

  // Load ignore list and settings on init
  chrome.storage.local.get(['ignoreList', 'extensionSettings'], (data) => {
    if (data.ignoreList) ignoreList = new Set(data.ignoreList);
    if (data.extensionSettings) settings = { ...settings, ...data.extensionSettings };
  });

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.extensionSettings) {
      settings = { ...settings, ...changes.extensionSettings.newValue };
    }
  });

  // Item 8: URL change detection for SPA navigation (e.g. YouTube)
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('[CONTENT] URL changed, re-ensuring sidebar');
      const existingHost = document.getElementById('context-listener-host');
      if (!existingHost || !document.body.contains(existingHost)) {
        ensureSidebar();
      }
    }
  });
  if (document.body) {
    urlObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      urlObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

  const TYPE_COLORS = {
    stock: '#00e676',
    person: '#42a5f5',
    people: '#42a5f5',
    event: '#ffab00',
    concept: '#ab47bc',
    commodity: '#ef6c00',
    organization: '#42a5f5'
  };

  function getTypeColor(type) {
    return TYPE_COLORS[(type || '').toLowerCase()] || '#888';
  }

  function getTypeBadge(type) {
    return (type || 'OTHER').toUpperCase();
  }

  const SHADOW_CSS = `
    :host {
      all: initial;
    }

    #sidebar {
      width: 380px;
      height: 100vh;
      background: #12121a;
      border-left: 1px solid #2a2a3e;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0e0;
      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
    }

    #sidebar-header {
      display: flex;
      align-items: center;
      padding: 16px;
      border-bottom: 1px solid #2a2a3e;
      flex-shrink: 0;
      gap: 8px;
    }

    #sidebar-header .wordmark {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin: 0;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    #ctx-listen-btn {
      background: #00e676;
      color: #0a0a14;
      border: none;
      border-radius: 12px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
      margin-left: 8px;
    }
    #ctx-listen-btn:hover { background: #00c853; }
    #ctx-listen-btn.listening {
      background: #ff5252;
      color: white;
    }
    #ctx-listen-btn.listening:hover { background: #ff1744; }

    .light-theme #ctx-listen-btn { background: #059669; color: white; }
    .light-theme #ctx-listen-btn:hover { background: #047857; }
    .light-theme #ctx-listen-btn.listening { background: #dc2626; }

    .header-spacer {
      flex: 1;
    }

    .header-btn {
      background: none;
      border: none;
      color: #666;
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }

    .header-btn:hover {
      background: #2a2a3e;
      color: #fff;
    }

    #sidebar-cards {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }

    #sidebar-cards::-webkit-scrollbar {
      width: 6px;
    }

    #sidebar-cards::-webkit-scrollbar-track {
      background: transparent;
    }

    #sidebar-cards::-webkit-scrollbar-thumb {
      background: #333;
      border-radius: 3px;
    }

    .context-card {
      position: relative;
      padding: 16px;
      border-bottom: 1px solid #2a2a3e;
      animation: context-card-in 0.35s ease-out both;
      transition: opacity 0.5s ease;
    }

    .context-card.aged {
      opacity: 0.5;
      transition: opacity 0.5s ease;
    }
    .context-card.aged:hover {
      opacity: 1;
    }

    @keyframes context-card-in {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .context-card.collapsed {
      animation: none;
    }

    .context-card .type-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .context-card .ticker {
      font-size: 20px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 2px;
    }

    .context-card .company-name {
      font-size: 12px;
      color: #888;
      margin-bottom: 10px;
    }

    .context-card .price-row {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .context-card .price {
      font-size: 22px;
      font-weight: 600;
      color: #fff;
    }

    .context-card .change {
      font-size: 13px;
      font-weight: 600;
    }

    .context-card .change.positive {
      color: #00e676;
    }

    .context-card .change.negative {
      color: #ff5252;
    }

    .context-card .term {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 6px;
    }

    .context-card .description {
      font-size: 13px;
      color: #aaa;
      line-height: 1.6;
    }

    .context-card .card-timestamp {
      font-size: 11px;
      color: #555;
      text-align: right;
      margin-top: 8px;
    }

    .context-card .thumbs-down-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: none;
      border: none;
      color: #555;
      font-size: 14px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 4px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
    }

    .context-card .thumbs-down-btn:hover {
      color: #ff5252;
      background: rgba(255, 82, 82, 0.1);
    }

    .context-card .feedback-msg {
      font-size: 12px;
      color: #888;
      padding: 8px 0;
      text-align: center;
    }
  `;

  function ensureSidebar() {
    if (host && document.body.contains(host)) return;

    // Item 7: Create host element with zero footprint when hidden
    host = document.createElement('div');
    host.id = 'context-listener-host';
    host.style.pointerEvents = 'none';
    host.style.width = '0';
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.right = '0';
    host.style.height = '100vh';
    host.style.zIndex = '2147483647';
    host.style.overflow = 'hidden';
    // Item 13: Slide animation via host width transition
    host.style.transition = 'width 0.2s ease-out';
    document.body.appendChild(host);

    // Create Shadow DOM
    shadowRoot = host.attachShadow({ mode: 'open' });

    // Inject styles
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadowRoot.appendChild(style);

    // Create sidebar
    sidebar = document.createElement('div');
    sidebar.id = 'sidebar';

    // Header with wordmark, Start/Stop, Clear, Close
    const header = document.createElement('div');
    header.id = 'sidebar-header';
    header.innerHTML = `
      <span class="wordmark">context</span>
      <button id="ctx-listen-btn" title="Start Listening">\u25CF Start</button>
      <span class="header-spacer"></span>
      <button class="header-btn" id="ctx-clear-btn" title="Clear">\u{1F5D1}</button>
      <button class="header-btn" id="ctx-close-btn" title="Close">&times;</button>
    `;

    // Cards container
    cardContainer = document.createElement('div');
    cardContainer.id = 'sidebar-cards';

    sidebar.appendChild(header);
    sidebar.appendChild(cardContainer);
    shadowRoot.appendChild(sidebar);

    // Wire close button
    const closeBtn = shadowRoot.getElementById('ctx-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        host.style.width = '0';
        host.style.pointerEvents = 'none';
      });
    }

    // Wire clear button
    const clearBtn = shadowRoot.getElementById('ctx-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        cardContainer.innerHTML = '';
        recentTerms.clear();
      });
    }

    // Item 4: Wire Start/Stop button
    const listenBtn = shadowRoot.getElementById('ctx-listen-btn');
    if (listenBtn) {
      listenBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_CAPTURE' });
      });
    }

    // Item 6: Sync capture state when sidebar first opens
    chrome.storage.local.get('capturing', (data) => {
      const btn = shadowRoot.getElementById('ctx-listen-btn');
      if (btn && data.capturing) {
        btn.textContent = '\u25A0 Stop';
        btn.classList.add('listening');
      }
    });

    // Item 14: Auto-dim older cards every 30 seconds
    setInterval(() => {
      const cards = shadowRoot?.querySelectorAll('.context-card:not(.aged):not(.quick-known)');
      if (!cards) return;
      const twoMinAgo = Date.now() - 120000;
      cards.forEach(card => {
        const created = parseInt(card.dataset.createdAt || '0');
        if (created && created < twoMinAgo) {
          card.classList.add('aged');
        }
      });
    }, 30000);
  }

  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (settings.autoHide && host) {
      autoHideTimer = setTimeout(() => {
        host.style.width = '0';
        host.style.pointerEvents = 'none';
      }, 30000);
    }
  }

  function isDuplicate(term) {
    const now = Date.now();
    const lastSeen = recentTerms.get(term);
    if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
      return true;
    }
    recentTerms.set(term, now);
    return false;
  }

  function formatTime(date) {
    let hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const mins = minutes < 10 ? '0' + minutes : minutes;
    return `${hours}:${mins} ${ampm}`;
  }

  function addThumbsDown(card, key) {
    const btn = document.createElement('button');
    btn.className = 'thumbs-down-btn';
    btn.innerHTML = '&#x1F44E;';
    btn.title = 'Not useful';
    btn.addEventListener('click', () => {
      ignoreList.add(key);
      chrome.storage.local.set({ ignoreList: Array.from(ignoreList) });
      card.innerHTML = '<div class="feedback-msg">Thanks for the feedback</div>';
      card.classList.add('collapsed');
    });
    card.appendChild(btn);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';
    // Item 14: Stamp creation time for auto-dim
    card.dataset.createdAt = Date.now().toString();

    const typeColor = getTypeColor('stock');
    const typeBadge = `<div class="type-badge" style="color:${typeColor}">STOCK</div>`;
    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const timestamp = formatTime(new Date());

    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changeClass = changeVal >= 0 ? 'positive' : 'negative';
      const changePrefix = changeVal >= 0 ? '+' : '';
      const changePercent = entity.changePercent != null
        ? ` (${changePrefix}${parseFloat(entity.changePercent).toFixed(2)}%)`
        : '';

      card.innerHTML = `
        ${typeBadge}
        <div class="ticker">${ticker}</div>
        <div class="company-name">${companyName}</div>
        <div class="price-row">
          <span class="price">$${price.toFixed(2)}</span>
          <span class="change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}${changePercent}</span>
        </div>
        <div class="card-timestamp">${timestamp}</div>
      `;
    } else {
      card.innerHTML = `
        ${typeBadge}
        <div class="ticker">${ticker}</div>
        <div class="company-name">${companyName}</div>
        <div class="description">${escapeHtml(entity.description || '')}</div>
        <div class="card-timestamp">${timestamp}</div>
      `;
    }

    const key = entity.ticker || entity.term || entity.name || '';
    addThumbsDown(card, key);

    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';
    // Item 14: Stamp creation time for auto-dim
    card.dataset.createdAt = Date.now().toString();

    const type = entity.type || 'other';
    const typeColor = getTypeColor(type);
    const typeBadge = getTypeBadge(type);
    const timestamp = formatTime(new Date());

    card.innerHTML = `
      <div class="type-badge" style="color:${typeColor}">${typeBadge}</div>
      <div class="term">${escapeHtml(entity.term || entity.name || '')}</div>
      <div class="description">${escapeHtml(entity.description || '')}</div>
      <div class="card-timestamp">${timestamp}</div>
    `;

    const key = entity.term || entity.name || '';
    addThumbsDown(card, key);

    return card;
  }

  // Message listener
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Item 3: Handle TOGGLE_SIDEBAR
    if (msg.type === 'TOGGLE_SIDEBAR') {
      const h = document.getElementById('context-listener-host');
      if (!h) {
        ensureSidebar();
        // After creating, make it visible
        if (host) {
          host.style.width = '380px';
          host.style.pointerEvents = 'auto';
        }
      } else {
        // Item 7: Toggle using width + pointerEvents
        if (!h.style.width || h.style.width === '0' || h.style.width === '0px') {
          h.style.width = '380px';
          h.style.pointerEvents = 'auto';
        } else {
          h.style.width = '0';
          h.style.pointerEvents = 'none';
        }
      }
      sendResponse({ ok: true });
    }

    // Item 3: Handle PING
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
    }

    // Item 6: Update button state on capture changes
    if (msg.type === 'CAPTURE_STATE') {
      const btn = document.getElementById('context-listener-host')
        ?.shadowRoot?.getElementById('ctx-listen-btn');
      if (btn) {
        if (msg.capturing) {
          btn.textContent = '\u25A0 Stop';
          btn.classList.add('listening');
        } else {
          btn.textContent = '\u25CF Start';
          btn.classList.remove('listening');
        }
      }
    }

    // Handle context data (existing functionality)
    if (msg.type === 'CONTEXT_DATA') {
      ensureSidebar();

      const entities = msg.entities || [];
      let addedAny = false;
      let count = 0;

      for (const entity of entities) {
        if (count >= settings.cardsPerChunk) break;

        const key = entity.ticker || entity.term || entity.name || '';
        if (!key || isDuplicate(key)) continue;
        if (ignoreList.has(key)) continue;

        const card = entity.type === 'stock'
          ? createStockCard(entity)
          : createGenericCard(entity);

        cardContainer.prepend(card);
        addedAny = true;
        count++;
      }

      if (addedAny) {
        // Show sidebar
        host.style.width = '380px';
        host.style.pointerEvents = 'auto';
        resetAutoHide();
      }
    }
  });
})();
