console.log('[CONTENT] Script loaded');

if (!window.__contextExtensionLoaded) {
  window.__contextExtensionLoaded = true;

  const DEDUP_WINDOW = 600000; // 10 minutes
  const seenTerms = new Map(); // term -> timestamp
  let lastSessionStart = null;

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
        width: 280px;
        height: 100vh;
        background: #111118;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #e0e0e0;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      #context-sidebar.pos-right {
        right: 0;
        border-left: 1px solid #1e1e2a;
        box-shadow: -2px 0 12px rgba(0, 0, 0, 0.3);
        transform: translateX(100%);
      }

      #context-sidebar.pos-left {
        left: 0;
        border-right: 1px solid #1e1e2a;
        box-shadow: 2px 0 12px rgba(0, 0, 0, 0.3);
        transform: translateX(-100%);
      }

      #context-sidebar.open {
        transform: translateX(0) !important;
      }

      #context-sidebar-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #1e1e2a;
        flex-shrink: 0;
      }

      #context-sidebar-header h2 {
        font-size: 11px;
        font-weight: 600;
        color: #555;
        margin: 0;
        letter-spacing: 1px;
      }

      #context-sidebar-close {
        background: none;
        border: none;
        color: #444;
        font-size: 16px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
      }

      #context-sidebar-close:hover {
        color: #aaa;
      }

      #context-sidebar-cards {
        flex: 1;
        overflow-y: auto;
        padding: 0;
      }

      #context-sidebar-cards::-webkit-scrollbar {
        width: 4px;
      }

      #context-sidebar-cards::-webkit-scrollbar-track {
        background: transparent;
      }

      #context-sidebar-cards::-webkit-scrollbar-thumb {
        background: #222;
        border-radius: 2px;
      }

      .context-card {
        position: relative;
        padding: 10px 12px;
        border-bottom: 1px solid #1e1e2a;
        animation: context-card-in 0.25s ease-out both;
      }

      @keyframes context-card-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .context-card.collapsed {
        animation: none;
      }

      .context-card .term-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 3px;
      }

      .context-card .term-name {
        font-size: 13px;
        font-weight: 700;
        color: #ccc;
      }

      .context-card .inline-time {
        font-size: 10px;
        color: #444;
        flex-shrink: 0;
        margin-left: 8px;
      }

      .context-card .description {
        font-size: 12px;
        color: #888;
        line-height: 1.5;
      }

      .context-card .stock-row {
        display: flex;
        align-items: baseline;
        gap: 6px;
      }

      .context-card .ticker {
        font-size: 13px;
        font-weight: 700;
        color: #ccc;
      }

      .context-card .company-name {
        font-size: 11px;
        color: #555;
      }

      .context-card .stock-price {
        font-size: 12px;
        color: #999;
        margin-left: auto;
      }

      .context-card .change {
        font-size: 11px;
        font-weight: 600;
      }

      .context-card .change.positive {
        color: #00c853;
      }

      .context-card .change.negative {
        color: #ef5350;
      }

      .context-card .thumbs-down-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        background: none;
        border: none;
        color: #333;
        font-size: 11px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 3px;
        line-height: 1;
        opacity: 0;
        transition: opacity 0.15s, color 0.15s;
      }

      .context-card:hover .thumbs-down-btn {
        opacity: 1;
      }

      .context-card .thumbs-down-btn:hover {
        color: #ef5350;
      }

      .context-card .feedback-msg {
        font-size: 11px;
        color: #555;
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
    });
    card.appendChild(btn);
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const timestamp = formatTime(new Date());

    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changeClass = changeVal >= 0 ? 'positive' : 'negative';
      const changePrefix = changeVal >= 0 ? '+' : '';

      card.innerHTML = `
        <div class="stock-row">
          <span class="ticker">${ticker}</span>
          <span class="company-name">${companyName}</span>
          <span class="stock-price">$${price.toFixed(2)}</span>
          <span class="change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}</span>
          <span class="inline-time">${timestamp}</span>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="term-header">
          <span class="ticker">${ticker}</span>
          <span class="inline-time">${timestamp}</span>
        </div>
        <div class="description">${escapeHtml(firstSentence(entity.description || ''))}</div>
      `;
    }

    const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);

    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    card.className = 'context-card';

    const timestamp = formatTime(new Date());
    const desc = firstSentence(entity.description || '');

    card.innerHTML = `
      <div class="term-header">
        <span class="term-name">${escapeHtml(entity.term || entity.name || '')}</span>
        <span class="inline-time">${timestamp}</span>
      </div>
      ${desc ? `<div class="description">${escapeHtml(desc)}</div>` : ''}
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
    return sidebar;
  }

  function renderSessionDivider(timestamp) {
    if (timestamp === lastSessionStart) return;
    lastSessionStart = timestamp;

    const sidebar = ensureSidebar();
    const timeStr = formatTime(new Date(timestamp));

    const divider = document.createElement('div');
    divider.className = 'context-session-divider';
    divider.style.cssText = 'display:flex;align-items:center;gap:8px;padding:12px 16px;';
    divider.innerHTML =
      '<hr style="flex:1;border:none;border-top:1px solid #333;margin:0;">' +
      '<span style="color:#666;font-size:11px;white-space:nowrap;">Session started ' + timeStr + '</span>' +
      '<hr style="flex:1;border:none;border-top:1px solid #333;margin:0;">';

    sidebar.prepend(divider);
    console.log('[CONTENT] Session divider added:', timeStr);
  }

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards:', entities.length, 'entities');

    const sidebar = ensureSidebar();
    const cardContainer = document.getElementById('context-sidebar-cards');

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

  // Listen for future updates (no activeTabId check — render whenever pendingEntities exists)
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

  // Check for pending entities on load (no activeTabId check)
  chrome.storage.local.get(['pendingEntities', 'sessionStart'], (data) => {
    if (data.sessionStart) {
      renderSessionDivider(data.sessionStart);
    }
    console.log('[CONTENT] Initial check:', data.pendingEntities ? data.pendingEntities.length + ' entities' : 'none');
    if (data.pendingEntities) {
      renderCards(data.pendingEntities);
    }
  });

  // Polling fallback: every 2 seconds, check for pendingEntities and render if found
  setInterval(() => {
    chrome.storage.local.get(['pendingEntities'], (data) => {
      if (data.pendingEntities && data.pendingEntities.length > 0) {
        console.log('[CONTENT] Polling fallback found', data.pendingEntities.length, 'entities');
        renderCards(data.pendingEntities);
      }
    });
  }, 2000);
}
