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

  // All styles live inside shadow DOM — completely isolated from host page CSS
  const SHADOW_CSS = `
    *, *::before, *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :host {
      all: initial;
    }

    #context-sidebar {
      width: 100%;
      height: 100%;
      background: #0e0e16;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0f0;
      overflow: hidden;
    }

    #context-sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: #0e0e16;
      border-bottom: 1px solid #1e1e2e;
      flex-shrink: 0;
    }

    .ctx-wordmark {
      font-size: 13px;
      font-weight: 500;
      color: #e0e0f0;
      letter-spacing: 0.01em;
    }

    .ctx-live {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .ctx-live-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #00e676;
      animation: ctx-pulse 2s ease-in-out infinite;
    }

    .ctx-live-text {
      font-size: 10px;
      color: #00e676;
      font-weight: 500;
    }

    @keyframes ctx-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 4px #00e676; }
      50% { opacity: 0.4; box-shadow: 0 0 8px #00e676; }
    }

    /* Empty state */
    #context-sidebar-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: #0e0e16;
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
      background: #0e0e16;
    }

    #context-sidebar-cards::-webkit-scrollbar { width: 3px; }
    #context-sidebar-cards::-webkit-scrollbar-track { background: transparent; }
    #context-sidebar-cards::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }

    /* Session divider */
    .context-session-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: #0e0e16;
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
      background: #0e0e16;
      animation: ctx-card-in 0.25s ease-out both;
    }

    @keyframes ctx-card-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .context-card.collapsed {
      animation: none;
    }

    .card-type {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 3px;
    }

    .card-term {
      font-size: 13px;
      font-weight: 600;
      color: #d0d0e8;
      margin-bottom: 4px;
    }

    .card-desc {
      font-size: 11px;
      color: #4a4a6a;
      line-height: 1.55;
    }

    .card-time {
      font-size: 10px;
      color: #2a2a3a;
      float: right;
      margin-top: 4px;
    }

    /* Stock cards */
    .stock-ticker {
      font-size: 18px;
      font-weight: 700;
      color: #e0e0f0;
      margin-bottom: 1px;
    }

    .stock-company {
      font-size: 10px;
      color: #3a3a5a;
      margin-bottom: 8px;
    }

    .stock-price-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .stock-price {
      font-size: 16px;
      font-weight: 600;
      color: #e0e0f0;
    }

    .stock-change {
      font-size: 12px;
      font-weight: 600;
    }

    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }

    /* Thumbs down */
    .thumbs-down-btn {
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
    .thumbs-down-btn:hover { color: #ff5252; }

    .feedback-msg {
      font-size: 11px;
      color: #3a3a5a;
      padding: 4px 0;
      text-align: center;
    }
  `;

  function enforceHostStyles() {
    if (!hostEl) return;
    hostEl.style.setProperty('background', '#0e0e16', 'important');
    hostEl.style.setProperty('background-color', '#0e0e16', 'important');
    hostEl.style.setProperty('color', '#e0e0f0', 'important');
    hostEl.style.setProperty('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", 'important');
  }

  function getHostCSS() {
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    const borderSide = pos === 'right' ? 'border-left' : 'border-right';
    return `position:fixed;top:0;${pos}:0;width:300px;height:100vh;z-index:2147483647;background:#0e0e16;${borderSide}:1px solid #1e1e2e;transform:translateX(${pos === 'right' ? '100%' : '-100%'});transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);`;
  }

  function applySidebarPosition() {
    if (!hostEl) return;
    const isOpen = hostEl.dataset.open === 'true';
    hostEl.style.cssText = getHostCSS();
    enforceHostStyles();
    if (isOpen) hostEl.style.transform = 'translateX(0)';
  }

  function openSidebar() {
    if (!hostEl) return;
    hostEl.dataset.open = 'true';
    hostEl.style.transform = 'translateX(0)';
    enforceHostStyles();
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
    if (shadowRoot) return shadowRoot.getElementById('context-sidebar');

    // Create host element with inline styles (immune to page CSS)
    hostEl = document.createElement('div');
    hostEl.id = 'context-sidebar-host';
    hostEl.style.cssText = getHostCSS();

    // Attach shadow root — complete CSS isolation
    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    // Inject styles into shadow root (page CSS cannot reach here)
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadowRoot.appendChild(style);

    // Sidebar container (fills shadow host)
    const sidebar = document.createElement('div');
    sidebar.id = 'context-sidebar';

    // Header
    const header = document.createElement('div');
    header.id = 'context-sidebar-header';
    header.innerHTML = `
      <span class="ctx-wordmark">context</span>
      <div class="ctx-live">
        <span class="ctx-live-dot"></span>
        <span class="ctx-live-text">Live</span>
      </div>
    `;

    // Empty state
    const emptyState = document.createElement('div');
    emptyState.id = 'context-sidebar-empty';
    emptyState.innerHTML = `
      <div class="ctx-empty-dots"><span></span><span></span><span></span></div>
      <div class="ctx-empty-text">Listening...</div>
    `;

    // Cards container
    const cardContainer = document.createElement('div');
    cardContainer.id = 'context-sidebar-cards';
    cardContainer.style.display = 'none';

    sidebar.appendChild(header);
    sidebar.appendChild(emptyState);
    sidebar.appendChild(cardContainer);
    shadowRoot.appendChild(sidebar);
    document.body.appendChild(hostEl);

    // Force styles on both host element and inner sidebar
    const forceStyles = () => {
      hostEl.style.setProperty('background', '#0e0e16', 'important');
      hostEl.style.setProperty('background-color', '#0e0e16', 'important');
      hostEl.style.setProperty('color', '#e0e0f0', 'important');
      hostEl.style.setProperty('border-left', '1px solid #1e1e2e', 'important');
      sidebar.style.setProperty('background', '#0e0e16', 'important');
      sidebar.style.setProperty('color', '#e0e0f0', 'important');
      if (cardContainer) {
        cardContainer.style.setProperty('background', '#0e0e16', 'important');
      }
    };
    forceStyles();

    // MutationObserver: re-enforce if YouTube mutates host style/class
    const styleObserver = new MutationObserver(forceStyles);
    styleObserver.observe(hostEl, { attributes: true, attributeFilter: ['style', 'class'] });

    // Interval fallback: re-enforce every 500ms in case anything overrides
    setInterval(forceStyles, 500);

    console.log('[CONTENT] Shadow DOM sidebar created, style enforcement active');
    return sidebar;
  }

  function showCardsHideEmpty() {
    if (hasCards || !shadowRoot) return;
    hasCards = true;
    const empty = shadowRoot.getElementById('context-sidebar-empty');
    const cards = shadowRoot.getElementById('context-sidebar-cards');
    if (empty) empty.style.display = 'none';
    if (cards) cards.style.display = 'block';
  }

  function renderSessionDivider(timestamp) {
    if (timestamp === lastSessionStart) return;
    lastSessionStart = timestamp;

    ensureSidebar();
    const cardContainer = shadowRoot.getElementById('context-sidebar-cards');
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

    ensureSidebar();
    const cardContainer = shadowRoot.getElementById('context-sidebar-cards');

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

    openSidebar();
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
