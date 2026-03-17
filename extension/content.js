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

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.extensionSettings) {
      settings = { ...settings, ...changes.extensionSettings.newValue };
      applySidebarPosition();
    }
  });

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
    if (idx === -1) return str;
    return str.slice(0, idx + 1);
  }

  function injectStyles() {
    if (document.getElementById('context-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'context-sidebar-styles';
    style.textContent = `
      #context-sidebar {
        position: fixed;
        top: 0;
        width: 300px;
        height: 100vh;
        background: #0e0e16;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #e0e0f0;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      #context-sidebar.pos-right {
        right: 0;
        border-left: 1px solid #1e1e2e;
        transform: translateX(100%);
      }

      #context-sidebar.pos-left {
        left: 0;
        border-right: 1px solid #1e1e2e;
        transform: translateX(-100%);
      }

      #context-sidebar.open {
        transform: translateX(0) !important;
      }

      /* Header */
      #context-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        background: #0e0e16;
        border-bottom: 1px solid #1e1e2e;
        flex-shrink: 0;
      }

      #context-sidebar-header .ctx-wordmark {
        font-size: 13px;
        font-weight: 500;
        color: #e0e0f0;
        letter-spacing: 0.01em;
      }

      #context-sidebar-header .ctx-live {
        display: flex;
        align-items: center;
        gap: 5px;
      }

      #context-sidebar-header .ctx-live-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #00e676;
        animation: ctx-pulse 2s ease-in-out infinite;
      }

      @keyframes ctx-pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 4px #00e676; }
        50% { opacity: 0.4; box-shadow: 0 0 8px #00e676; }
      }

      #context-sidebar-header .ctx-live-text {
        font-size: 10px;
        color: #00e676;
        font-weight: 500;
      }

      /* Empty state */
      #context-sidebar-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
      }

      .ctx-empty-dots {
        display: flex;
        gap: 6px;
      }

      .ctx-empty-dots span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #3a3a5a;
        animation: ctx-dot-pulse 1.4s ease-in-out infinite;
      }

      .ctx-empty-dots span:nth-child(2) { animation-delay: 0.2s; }
      .ctx-empty-dots span:nth-child(3) { animation-delay: 0.4s; }

      @keyframes ctx-dot-pulse {
        0%, 80%, 100% { opacity: 0.3; transform: scale(1); }
        40% { opacity: 1; transform: scale(1.2); }
      }

      .ctx-empty-text {
        font-size: 12px;
        color: #3a3a5a;
      }

      /* Cards container */
      #context-sidebar-cards {
        flex: 1;
        overflow-y: auto;
        padding: 0;
      }

      #context-sidebar-cards::-webkit-scrollbar {
        width: 3px;
      }

      #context-sidebar-cards::-webkit-scrollbar-track {
        background: transparent;
      }

      #context-sidebar-cards::-webkit-scrollbar-thumb {
        background: #1e1e2e;
        border-radius: 2px;
      }

      /* Session divider */
      .context-session-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 16px;
      }

      .context-session-divider hr {
        flex: 1;
        border: none;
        border-top: 1px solid #1e1e2e;
        margin: 0;
      }

      .context-session-divider span {
        color: #3a3a5a;
        font-size: 10px;
        white-space: nowrap;
      }

      /* Cards */
      .context-card {
        position: relative;
        padding: 13px 16px 11px 18px;
        border-bottom: 1px solid #161620;
        border-left: 2px solid #4a4a6a;
        animation: ctx-card-in 0.25s ease-out both;
      }

      @keyframes ctx-card-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .context-card.collapsed {
        animation: none;
      }

      .context-card .card-type {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        margin-bottom: 3px;
      }

      .context-card .card-term {
        font-size: 13px;
        font-weight: 600;
        color: #d0d0e8;
        margin-bottom: 4px;
      }

      .context-card .card-desc {
        font-size: 11px;
        color: #4a4a6a;
        line-height: 1.55;
      }

      .context-card .card-time {
        font-size: 10px;
        color: #2a2a3a;
        float: right;
        margin-top: 4px;
      }

      /* Stock cards */
      .context-card .stock-ticker {
        font-size: 18px;
        font-weight: 700;
        color: #e0e0f0;
        margin-bottom: 1px;
      }

      .context-card .stock-company {
        font-size: 10px;
        color: #3a3a5a;
        margin-bottom: 8px;
      }

      .context-card .stock-price-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }

      .context-card .stock-price {
        font-size: 16px;
        font-weight: 600;
        color: #e0e0f0;
      }

      .context-card .stock-change {
        font-size: 12px;
        font-weight: 600;
      }

      .context-card .stock-change.positive { color: #00e676; }
      .context-card .stock-change.negative { color: #ff5252; }

      /* Thumbs down */
      .context-card .thumbs-down-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        background: none;
        border: none;
        color: #2a2a3a;
        font-size: 10px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 3px;
        line-height: 1;
        opacity: 0;
        transition: opacity 0.15s, color 0.15s;
      }

      .context-card:hover .thumbs-down-btn { opacity: 1; }
      .context-card .thumbs-down-btn:hover { color: #ff5252; }

      .context-card .feedback-msg {
        font-size: 11px;
        color: #3a3a5a;
        padding: 4px 0;
        text-align: center;
      }
    `;
    document.head.appendChild(style);
  }

  function applySidebarPosition() {
    const sidebar = document.getElementById('context-sidebar');
    if (!sidebar) return;
    sidebar.classList.remove('pos-left', 'pos-right');
    sidebar.classList.add(settings.sidebarPosition === 'left' ? 'pos-left' : 'pos-right');
  }

  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (settings.autoHide) {
      const sidebar = document.getElementById('context-sidebar');
      if (sidebar) {
        autoHideTimer = setTimeout(() => {
          sidebar.classList.remove('open');
        }, 30000);
      }
    }
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
      card.style.borderLeftColor = '#4a4a6a';
    });
    card.appendChild(btn);
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';
    const color = getTypeColor('stock');
    card.style.borderLeftColor = color;

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const timestamp = formatTime(new Date());

    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changeClass = changeVal >= 0 ? 'positive' : 'negative';
      const changePrefix = changeVal >= 0 ? '+' : '';

      card.innerHTML = `
        <div class="card-type" style="color:${color}">STOCK</div>
        <div class="stock-ticker">${ticker}</div>
        <div class="stock-company">${companyName}</div>
        <div class="stock-price-row">
          <span class="stock-price">$${price.toFixed(2)}</span>
          <span class="stock-change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}</span>
        </div>
        <span class="card-time">${timestamp}</span>
      `;
    } else {
      card.innerHTML = `
        <div class="card-type" style="color:${color}">STOCK</div>
        <div class="stock-ticker">${ticker}</div>
        <div class="stock-company">${companyName}</div>
        <div class="card-desc">${escapeHtml(firstSentence(entity.description || ''))}</div>
        <span class="card-time">${timestamp}</span>
      `;
    }

    const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);
    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';
    const type = entity.type || 'other';
    const color = getTypeColor(type);
    card.style.borderLeftColor = color;

    const timestamp = formatTime(new Date());
    const desc = firstSentence(entity.description || '');
    const typeLabel = (type || 'OTHER').toUpperCase();

    card.innerHTML = `
      <div class="card-type" style="color:${color}">${typeLabel}</div>
      <div class="card-term">${escapeHtml(entity.term || entity.name || '')}</div>
      ${desc ? `<div class="card-desc">${escapeHtml(desc)}</div>` : ''}
      <span class="card-time">${timestamp}</span>
    `;

    const key = (entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);
    return card;
  }

  function ensureSidebar() {
    injectStyles();

    let sidebar = document.getElementById('context-sidebar');
    let cardContainer;

    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.id = 'context-sidebar';
      sidebar.classList.add(settings.sidebarPosition === 'left' ? 'pos-left' : 'pos-right');

      const header = document.createElement('div');
      header.id = 'context-sidebar-header';
      header.innerHTML = `
        <span class="ctx-wordmark">context</span>
        <div class="ctx-live">
          <span class="ctx-live-dot"></span>
          <span class="ctx-live-text">Live</span>
        </div>
      `;

      const emptyState = document.createElement('div');
      emptyState.id = 'context-sidebar-empty';
      emptyState.innerHTML = `
        <div class="ctx-empty-dots"><span></span><span></span><span></span></div>
        <div class="ctx-empty-text">Listening...</div>
      `;

      cardContainer = document.createElement('div');
      cardContainer.id = 'context-sidebar-cards';
      cardContainer.style.display = 'none';

      sidebar.appendChild(header);
      sidebar.appendChild(emptyState);
      sidebar.appendChild(cardContainer);
      document.body.appendChild(sidebar);

      console.log('[CONTENT] Sidebar created');
    } else {
      cardContainer = document.getElementById('context-sidebar-cards');
    }
    return sidebar;
  }

  function showCardsHideEmpty() {
    if (hasCards) return;
    hasCards = true;
    const empty = document.getElementById('context-sidebar-empty');
    const cards = document.getElementById('context-sidebar-cards');
    if (empty) empty.style.display = 'none';
    if (cards) cards.style.display = 'block';
  }

  function renderSessionDivider(timestamp) {
    if (timestamp === lastSessionStart) return;
    lastSessionStart = timestamp;

    ensureSidebar();
    const cardContainer = document.getElementById('context-sidebar-cards');
    const timeStr = formatTime(new Date(timestamp));

    const divider = document.createElement('div');
    divider.className = 'context-session-divider';
    divider.innerHTML =
      '<hr>' +
      '<span>Session started ' + timeStr + '</span>' +
      '<hr>';

    cardContainer.prepend(divider);
    showCardsHideEmpty();
    console.log('[CONTENT] Session divider added:', timeStr);
  }

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards:', entities.length, 'entities');

    const sidebar = ensureSidebar();
    const cardContainer = document.getElementById('context-sidebar-cards');

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

    showCardsHideEmpty();

    const limited = entities.slice(0, settings.cardsPerChunk);

    limited.forEach(entity => {
      const card = entity.type === 'stock'
        ? createStockCard(entity)
        : createGenericCard(entity);

      cardContainer.prepend(card);
      console.log('[CONTENT] Card added:', entity.ticker || entity.term || entity.name);
    });

    sidebar.classList.add('open');
    resetAutoHide();

    chrome.storage.local.remove('pendingEntities');
  }

  // Listen for future updates
  chrome.storage.onChanged.addListener((changes) => {
    console.log('[CONTENT] storage changed:', JSON.stringify(changes));
    if (changes.sessionStart && changes.sessionStart.newValue) {
      renderSessionDivider(changes.sessionStart.newValue);
    }
    if (changes.pendingEntities && changes.pendingEntities.newValue) {
      console.log('[CONTENT] storage.onChanged: pendingEntities updated with', changes.pendingEntities.newValue.length, 'entities');
      renderCards(changes.pendingEntities.newValue);
    }
  });

  // Check for pending entities on load
  chrome.storage.local.get(['pendingEntities', 'sessionStart'], (data) => {
    if (data.sessionStart) {
      renderSessionDivider(data.sessionStart);
    }
    console.log('[CONTENT] Initial check:', data.pendingEntities ? data.pendingEntities.length + ' entities' : 'none');
    if (data.pendingEntities) {
      renderCards(data.pendingEntities);
    }
  });

  // Polling fallback
  setInterval(() => {
    chrome.storage.local.get(['pendingEntities'], (data) => {
      if (data.pendingEntities && data.pendingEntities.length > 0) {
        console.log('[CONTENT] Polling fallback found', data.pendingEntities.length, 'entities');
        renderCards(data.pendingEntities);
      }
    });
  }, 2000);
}
