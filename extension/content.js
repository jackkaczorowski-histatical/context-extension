(() => {
  // Prevent duplicate initialization when injected multiple times
  if (window.__contextExtensionLoaded) return;
  window.__contextExtensionLoaded = true;
  console.log('[CONTENT] Content script loaded');

  const DEDUP_WINDOW_MS = 60000;
  const CARD_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const recentTerms = new Map();

  let shadowRoot = null;
  let sidebar = null;
  let cardContainer = null;

  const STYLES = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      right: 0;
      z-index: 2147483647;
      width: 0;
      height: 0;
    }

    #context-sidebar {
      position: fixed;
      top: 0;
      right: 0;
      width: 380px;
      height: 100vh;
      background: #12121a;
      border-left: 1px solid #2a2a3e;
      z-index: 2147483647;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0e0;
      box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
    }

    #context-sidebar.open {
      transform: translateX(0);
    }

    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px;
      border-bottom: 1px solid #2a2a3e;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      background: #12121a;
      z-index: 1;
    }

    .sidebar-header h2 {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin: 0;
      letter-spacing: 0.5px;
    }

    .sidebar-close {
      background: none;
      border: none;
      color: #666;
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }

    .sidebar-close:hover {
      background: #2a2a3e;
      color: #fff;
    }

    .sidebar-cards {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }

    .sidebar-cards::-webkit-scrollbar {
      width: 6px;
    }

    .sidebar-cards::-webkit-scrollbar-track {
      background: transparent;
    }

    .sidebar-cards::-webkit-scrollbar-thumb {
      background: #333;
      border-radius: 3px;
    }

    .context-card {
      background: #1e1e2e;
      border: 1px solid #2a2a3e;
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 10px;
      animation: context-card-in 0.3s ease-out;
    }

    @keyframes context-card-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .context-card-stock {
      border-left: 3px solid #7c4dff;
    }

    .context-card-other {
      border-left: 3px solid #29b6f6;
    }

    .context-card .ticker {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 2px;
    }

    .context-card .company-name {
      font-size: 11px;
      color: #888;
      margin-bottom: 10px;
    }

    .context-card .price-row {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .context-card .price {
      font-size: 20px;
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

    .context-card .entity-type {
      display: inline-block;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(41, 182, 246, 0.15);
      color: #29b6f6;
      margin-bottom: 8px;
    }

    .context-card-stock .entity-type {
      background: rgba(124, 77, 255, 0.15);
      color: #b388ff;
    }

    .context-card .term {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 6px;
    }

    .context-card .description {
      font-size: 12px;
      color: #aaa;
      line-height: 1.5;
    }

    .context-card .card-time {
      font-size: 10px;
      color: #555;
      margin-top: 8px;
      text-align: right;
    }
  `;

  function createSidebar() {
    if (sidebar) {
      console.log('[CONTENT] createSidebar: sidebar already exists');
      return;
    }

    console.log('[CONTENT] createSidebar: creating Shadow DOM host');

    // Create a host element and attach Shadow DOM
    const host = document.createElement('div');
    host.id = 'context-extension-host';
    shadowRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    shadowRoot.appendChild(style);

    sidebar = document.createElement('div');
    sidebar.id = 'context-sidebar';

    const header = document.createElement('div');
    header.className = 'sidebar-header';
    header.innerHTML = `
      <h2>CONTEXT</h2>
      <button class="sidebar-close">&times;</button>
    `;

    cardContainer = document.createElement('div');
    cardContainer.className = 'sidebar-cards';

    sidebar.appendChild(header);
    sidebar.appendChild(cardContainer);
    shadowRoot.appendChild(sidebar);
    document.body.appendChild(host);

    header.querySelector('.sidebar-close').addEventListener('click', () => {
      sidebar.classList.remove('open');
    });

    console.log('[CONTENT] createSidebar: Shadow DOM sidebar appended to body');
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

  function formatTime() {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function createStockCard(entity) {
    console.log('[CONTENT] Creating stock card:', entity.ticker);
    const card = document.createElement('div');
    card.className = 'context-card context-card-stock';

    const changeVal = parseFloat(entity.change) || 0;
    const changeClass = changeVal >= 0 ? 'positive' : 'negative';
    const changePrefix = changeVal >= 0 ? '+' : '';
    const changePercent = entity.changePercent != null
      ? ` (${changePrefix}${parseFloat(entity.changePercent).toFixed(2)}%)`
      : '';

    card.innerHTML = `
      <div class="entity-type">Stock</div>
      <div class="ticker">${escapeHtml(entity.ticker || '')}</div>
      <div class="company-name">${escapeHtml(entity.companyName || entity.name || '')}</div>
      <div class="price-row">
        <span class="price">$${parseFloat(entity.price || 0).toFixed(2)}</span>
        <span class="change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}${changePercent}</span>
      </div>
      <div class="card-time">${formatTime()}</div>
    `;

    return card;
  }

  function createGenericCard(entity) {
    console.log('[CONTENT] Creating generic card:', entity.term || entity.name);
    const card = document.createElement('div');
    card.className = 'context-card context-card-other';

    const typeLabel = entity.type || 'topic';

    card.innerHTML = `
      <div class="entity-type">${escapeHtml(typeLabel)}</div>
      <div class="term">${escapeHtml(entity.term || entity.name || '')}</div>
      ${entity.description ? `<div class="description">${escapeHtml(entity.description)}</div>` : ''}
      <div class="card-time">${formatTime()}</div>
    `;

    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[CONTENT] Message received:', message.type);

    if (message.type === 'CONTEXT_DATA') {
      console.log('[CONTENT] CONTEXT_DATA received with', (message.entities || []).length, 'entities');

      createSidebar();

      const entities = message.entities || [];
      let addedAny = false;

      entities.forEach(entity => {
        const key = entity.ticker || entity.term || entity.name || '';
        console.log('[CONTENT] Processing entity:', key, 'type:', entity.type);

        if (!key) {
          console.log('[CONTENT] Skipping entity with no key');
          return;
        }
        if (isDuplicate(key)) {
          console.log('[CONTENT] Skipping duplicate:', key);
          return;
        }

        const card = entity.type === 'stock'
          ? createStockCard(entity)
          : createGenericCard(entity);

        cardContainer.prepend(card);
        setTimeout(() => card.remove(), CARD_TTL_MS);
        addedAny = true;
        console.log('[CONTENT] Card added for:', key);
      });

      if (addedAny) {
        sidebar.classList.add('open');
        console.log('[CONTENT] Sidebar opened');
      } else {
        console.log('[CONTENT] No new cards added');
      }
    }
  });
})();
