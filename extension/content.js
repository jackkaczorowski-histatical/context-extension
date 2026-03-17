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
      background: #0e0e16;
    }
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    #sidebar {
      width: 100%; height: 100%; background: #0e0e16;
      display: flex; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #e0e0f0;
    }
    #header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 12px 12px 16px; background: #0e0e16;
      border-bottom: 1px solid rgba(255,255,255,0.04); flex-shrink: 0;
    }
    .ctx-wordmark { font-size: 13px; font-weight: 600; color: #e0e0f0; letter-spacing: -0.01em; }
    .ctx-header-right { display: flex; align-items: center; gap: 10px; }
    .ctx-live { display: flex; align-items: center; gap: 5px; }
    .ctx-live-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #00e676;
      animation: ctx-pulse 2s ease-in-out infinite;
    }
    .ctx-live-text { font-size: 10px; color: #00e676; font-weight: 500; }
    .ctx-close-btn {
      background: none; border: none; color: #3a3a5a; font-size: 16px;
      cursor: pointer; padding: 2px 6px; border-radius: 4px;
      line-height: 1; transition: color 0.15s, background 0.15s;
    }
    .ctx-close-btn:hover { color: #8a8aaa; background: rgba(255,255,255,0.05); }
    @keyframes ctx-pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 4px #00e676; }
      50% { opacity: 0.4; box-shadow: 0 0 8px #00e676; }
    }
    #empty-state {
      flex: 1; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px;
      background: #0e0e16;
    }
    .ctx-empty-dots { display: flex; gap: 6px; }
    .ctx-empty-dots span {
      width: 5px; height: 5px; border-radius: 50%; background: #3a3a5a;
      animation: ctx-dot-pulse 1.4s ease-in-out infinite;
    }
    .ctx-empty-dots span:nth-child(2) { animation-delay: 0.2s; }
    .ctx-empty-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes ctx-dot-pulse {
      0%, 80%, 100% { opacity: 0.3; transform: scale(1); }
      40% { opacity: 1; transform: scale(1.2); }
    }
    .ctx-empty-text { font-size: 12px; color: #3a3a5a; }
    #cards {
      flex: 1; overflow-y: auto; padding: 0; background: #0e0e16; display: none;
    }
    #cards::-webkit-scrollbar { width: 3px; }
    #cards::-webkit-scrollbar-track { background: transparent; }
    #cards::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
    .session-divider {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; background: #0e0e16;
    }
    .session-divider hr { flex: 1; border: none; border-top: 1px solid rgba(255,255,255,0.04); margin: 0; }
    .session-divider span { color: #3a3a5a; font-size: 10px; white-space: nowrap; }
    .context-card {
      position: relative; padding: 13px 16px 11px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.03); border-left: 2px solid #4a4a6a;
      background: #121220; animation: ctx-card-in 0.25s ease-out both;
    }
    .context-card:hover { background: #14142a; }
    @keyframes ctx-card-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .context-card.collapsed { animation: none; }
    .card-type {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; margin-bottom: 3px;
    }
    .card-term { font-size: 13px; font-weight: 600; color: #d0d0e8; margin-bottom: 4px; }
    .card-desc { font-size: 11px; color: #6a6a8a; line-height: 1.55; }
    .card-time { font-size: 10px; color: #2a2a3a; float: right; margin-top: 4px; }
    .stock-ticker { font-size: 18px; font-weight: 700; color: #e0e0f0; margin-bottom: 1px; }
    .stock-company { font-size: 10px; color: #3a3a5a; margin-bottom: 8px; }
    .stock-price-row { display: flex; align-items: baseline; gap: 8px; }
    .stock-price { font-size: 16px; font-weight: 600; color: #e0e0f0; }
    .stock-change { font-size: 12px; font-weight: 600; }
    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }
    .card-actions {
      position: absolute; top: 10px; right: 10px; display: flex; gap: 4px;
      opacity: 0; transition: opacity 0.15s;
    }
    .context-card:hover .card-actions { opacity: 1; }
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
      transition: color 0.15s; float: left; margin-top: 4px;
    }
    .card-wiki-link:hover { color: #7a7aaa; }
    .feedback-msg { font-size: 11px; color: #3a3a5a; padding: 4px 0; text-align: center; }
  `;

  function getHostPosition() {
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    const border = pos === 'right' ? 'border-left:1px solid #1e1e2e;' : 'border-right:1px solid #1e1e2e;';
    const translate = pos === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
    return `position:fixed;top:0;${pos}:0;width:280px;height:100vh;z-index:2147483647;${border}background:#0e0e16;transform:${translate};transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);`;
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
    upBtn.addEventListener('click', () => {
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
    downBtn.addEventListener('click', () => {
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
    addCardButtons(card, key, entity);
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

    const wikiTerm = (entity.term || entity.name || '').replace(/ /g, '_');
    const wikiUrl = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(wikiTerm);

    card.innerHTML = `
      <div class="card-type" style="color:${color}">${typeLabel}</div>
      <div class="card-term">${escapeHtml(entity.term || entity.name || '')}</div>
      ${desc ? `<div class="card-desc">${escapeHtml(desc)}</div>` : ''}
      <a class="card-wiki-link" href="${wikiUrl}" target="_blank" rel="noopener">Wikipedia &#x2197;</a>
      <span class="card-time">${timestamp}</span>
    `;

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
        <button class="ctx-close-btn" title="Close sidebar">&#x2715;</button>
      </div>
    `;

    // Wire up close button
    header.querySelector('.ctx-close-btn').addEventListener('click', () => {
      closeSidebar();
    });

    // Empty state
    const emptyState = document.createElement('div');
    emptyState.id = 'empty-state';
    emptyState.innerHTML = `
      <div class="ctx-empty-dots"><span></span><span></span><span></span></div>
      <div class="ctx-empty-text">Listening...</div>
    `;

    // Cards container
    const cardContainer = document.createElement('div');
    cardContainer.id = 'cards';

    sidebar.appendChild(header);
    sidebar.appendChild(emptyState);
    sidebar.appendChild(cardContainer);
    shadowRoot.appendChild(sidebar);
    document.body.appendChild(hostEl);

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

    showCardsHideEmpty();

    const limited = entities.slice(0, settings.cardsPerChunk);

    limited.forEach(entity => {
      const card = entity.type === 'stock'
        ? createStockCard(entity)
        : createGenericCard(entity);

      cards.prepend(card);
      console.log('[CONTENT] Card added:', entity.ticker || entity.term || entity.name);
    });

    openSidebar();
    resetAutoHide();

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
}
