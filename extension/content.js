console.log('CONTENT SCRIPT LOADED');

if (!window.__contextExtensionLoaded) {
  window.__contextExtensionLoaded = true;

  const DEDUP_WINDOW = 600000; // 10 minutes
  const seenTerms = new Map(); // term -> timestamp

  let ignoreList = new Set();
  let settings = {
    cardsPerChunk: 3,
    sidebarPosition: 'right',
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
      applySidebarPosition();
    }
  });

  const TYPE_COLORS = {
    stock: '#00e676',
    person: '#42a5f5',
    people: '#42a5f5',
    organization: '#42a5f5',
    event: '#ffab00',
    concept: '#ab47bc',
    commodity: '#ef6c00'
  };

  function getTypeColor(type) {
    return TYPE_COLORS[(type || '').toLowerCase()] || '#888';
  }

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

  function injectStyles() {
    if (document.getElementById('context-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'context-sidebar-styles';
    style.textContent = `
      #context-sidebar {
        position: fixed;
        top: 0;
        width: 380px;
        height: 100vh;
        background: #12121a;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #e0e0e0;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      #context-sidebar.pos-right {
        right: 0;
        border-left: 1px solid #2a2a3e;
        box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
        transform: translateX(100%);
      }

      #context-sidebar.pos-left {
        left: 0;
        border-right: 1px solid #2a2a3e;
        box-shadow: 4px 0 24px rgba(0, 0, 0, 0.4);
        transform: translateX(-100%);
      }

      #context-sidebar.open {
        transform: translateX(0) !important;
      }

      #context-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px;
        border-bottom: 1px solid #2a2a3e;
        flex-shrink: 0;
      }

      #context-sidebar-header h2 {
        font-size: 14px;
        font-weight: 600;
        color: #fff;
        margin: 0;
        letter-spacing: 0.5px;
      }

      #context-sidebar-close {
        background: none;
        border: none;
        color: #666;
        font-size: 18px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        line-height: 1;
      }

      #context-sidebar-close:hover {
        background: #2a2a3e;
        color: #fff;
      }

      #context-sidebar-cards {
        flex: 1;
        overflow-y: auto;
        padding: 0;
      }

      #context-sidebar-cards::-webkit-scrollbar {
        width: 6px;
      }

      #context-sidebar-cards::-webkit-scrollbar-track {
        background: transparent;
      }

      #context-sidebar-cards::-webkit-scrollbar-thumb {
        background: #333;
        border-radius: 3px;
      }

      .context-card {
        position: relative;
        padding: 16px;
        border-bottom: 1px solid #2a2a3e;
        animation: context-card-in 0.35s ease-out both;
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

      .context-card .term-name {
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
    });
    card.appendChild(btn);
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';

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

    const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);

    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';

    const type = entity.type || 'other';
    const typeColor = getTypeColor(type);
    const typeBadge = (type || 'OTHER').toUpperCase();
    const timestamp = formatTime(new Date());

    card.innerHTML = `
      <div class="type-badge" style="color:${typeColor}">${typeBadge}</div>
      <div class="term-name">${escapeHtml(entity.term || entity.name || '')}</div>
      <div class="description">${escapeHtml(entity.description || '')}</div>
      <div class="card-timestamp">${timestamp}</div>
    `;

    const key = (entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);

    return card;
  }

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards:', entities.length, 'entities');

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
        <h2>CONTEXT</h2>
        <button id="context-sidebar-close">&times;</button>
      `;

      cardContainer = document.createElement('div');
      cardContainer.id = 'context-sidebar-cards';

      sidebar.appendChild(header);
      sidebar.appendChild(cardContainer);
      document.body.appendChild(sidebar);

      document.getElementById('context-sidebar-close').addEventListener('click', () => {
        sidebar.classList.remove('open');
      });

      console.log('[CONTENT] Sidebar created');
    } else {
      cardContainer = document.getElementById('context-sidebar-cards');
    }

    const now = Date.now();

    // Clean expired entries from Map
    for (const [key, ts] of seenTerms) {
      if (now - ts > DEDUP_WINDOW) seenTerms.delete(key);
    }

    // Filter duplicates and ignored terms
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

    // Respect cardsPerChunk setting
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
    if (changes.pendingEntities && changes.pendingEntities.newValue) {
      console.log('[CONTENT] storage.onChanged: pendingEntities updated with', changes.pendingEntities.newValue.length, 'entities');
      renderCards(changes.pendingEntities.newValue);
    }
  });

  // Check for pending entities on load
  chrome.storage.local.get('pendingEntities', (data) => {
    console.log('[CONTENT] Initial check:', data.pendingEntities ? data.pendingEntities.length + ' entities' : 'none');
    if (data.pendingEntities) {
      renderCards(data.pendingEntities);
    }
  });
}
