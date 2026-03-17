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

  // Minimal style tag — only for things that CANNOT be inlined (keyframes, hover, scrollbar)
  function injectMinimalStyles() {
    if (document.getElementById('context-sidebar-styles')) return;
    const style = document.createElement('style');
    style.id = 'context-sidebar-styles';
    style.textContent = `
      @keyframes ctx-pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 4px #00e676; }
        50% { opacity: 0.4; box-shadow: 0 0 8px #00e676; }
      }
      @keyframes ctx-dot-pulse {
        0%, 80%, 100% { opacity: 0.3; transform: scale(1); }
        40% { opacity: 1; transform: scale(1.2); }
      }
      @keyframes ctx-card-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #context-sidebar-cards::-webkit-scrollbar { width: 3px; }
      #context-sidebar-cards::-webkit-scrollbar-track { background: transparent; }
      #context-sidebar-cards::-webkit-scrollbar-thumb { background: #1e1e2e; border-radius: 2px; }
    `;
    document.head.appendChild(style);
  }

  function getSidebarCSS() {
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    const borderSide = pos === 'right' ? 'border-left' : 'border-right';
    return `position:fixed;top:0;${pos}:0;width:300px;height:100vh;background:#0e0e16;z-index:2147483647;display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e0e0f0;${borderSide}:1px solid #1e1e2e;overflow:hidden;transform:translateX(${pos === 'right' ? '100%' : '-100%'});transition:transform 0.3s cubic-bezier(0.4,0,0.2,1);`;
  }

  function applySidebarPosition() {
    const sidebar = document.getElementById('context-sidebar');
    if (!sidebar) return;
    const isOpen = sidebar.dataset.open === 'true';
    sidebar.style.cssText = getSidebarCSS();
    if (isOpen) sidebar.style.transform = 'translateX(0)';
  }

  function openSidebar(sidebar) {
    sidebar.dataset.open = 'true';
    sidebar.style.transform = 'translateX(0)';
  }

  function closeSidebar(sidebar) {
    sidebar.dataset.open = 'false';
    const pos = settings.sidebarPosition === 'left' ? 'left' : 'right';
    sidebar.style.transform = pos === 'right' ? 'translateX(100%)' : 'translateX(-100%)';
  }

  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (settings.autoHide) {
      const sidebar = document.getElementById('context-sidebar');
      if (sidebar) {
        autoHideTimer = setTimeout(() => closeSidebar(sidebar), 30000);
      }
    }
  }

  function addThumbsDown(card, key) {
    const btn = document.createElement('button');
    btn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:#2a2a3a;font-size:10px;cursor:pointer;padding:2px 4px;border-radius:3px;line-height:1;opacity:0;transition:opacity 0.15s,color 0.15s;';
    btn.innerHTML = '&#x1F44E;';
    btn.title = 'Not useful';

    card.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    card.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
    btn.addEventListener('mouseenter', () => { btn.style.color = '#ff5252'; });
    btn.addEventListener('mouseleave', () => { btn.style.color = '#2a2a3a'; });

    btn.addEventListener('click', () => {
      ignoreList.add(key);
      chrome.storage.local.set({ ignoreList: Array.from(ignoreList) });
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:11px;color:#3a3a5a;padding:4px 0;text-align:center;';
      msg.textContent = 'Thanks for the feedback';
      card.innerHTML = '';
      card.appendChild(msg);
      card.style.animation = 'none';
      card.style.borderLeftColor = '#4a4a6a';
    });
    card.appendChild(btn);
  }

  function createStockCard(entity) {
    const card = document.createElement('div');
    const color = getTypeColor('stock');
    card.style.cssText = `position:relative;padding:13px 16px 11px 18px;border-bottom:1px solid #161620;border-left:2px solid ${color};background:#0e0e16;animation:ctx-card-in 0.25s ease-out both;`;

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const timestamp = formatTime(new Date());

    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changeColor = changeVal >= 0 ? '#00e676' : '#ff5252';
      const changePrefix = changeVal >= 0 ? '+' : '';

      card.innerHTML = `
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:3px;color:${color}">STOCK</div>
        <div style="font-size:18px;font-weight:700;color:#e0e0f0;margin-bottom:1px">${ticker}</div>
        <div style="font-size:10px;color:#3a3a5a;margin-bottom:8px">${companyName}</div>
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:16px;font-weight:600;color:#e0e0f0">$${price.toFixed(2)}</span>
          <span style="font-size:12px;font-weight:600;color:${changeColor}">${changePrefix}${changeVal.toFixed(2)}</span>
        </div>
        <span style="font-size:10px;color:#2a2a3a;float:right;margin-top:4px">${timestamp}</span>
      `;
    } else {
      card.innerHTML = `
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:3px;color:${color}">STOCK</div>
        <div style="font-size:18px;font-weight:700;color:#e0e0f0;margin-bottom:1px">${ticker}</div>
        <div style="font-size:10px;color:#3a3a5a;margin-bottom:8px">${companyName}</div>
        <div style="font-size:11px;color:#4a4a6a;line-height:1.55">${escapeHtml(firstSentence(entity.description || ''))}</div>
        <span style="font-size:10px;color:#2a2a3a;float:right;margin-top:4px">${timestamp}</span>
      `;
    }

    const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);
    return card;
  }

  function createGenericCard(entity) {
    const card = document.createElement('div');
    const type = entity.type || 'other';
    const color = getTypeColor(type);
    card.style.cssText = `position:relative;padding:13px 16px 11px 18px;border-bottom:1px solid #161620;border-left:2px solid ${color};background:#0e0e16;animation:ctx-card-in 0.25s ease-out both;`;

    const timestamp = formatTime(new Date());
    const desc = firstSentence(entity.description || '');
    const typeLabel = (type || 'OTHER').toUpperCase();

    card.innerHTML = `
      <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:3px;color:${color}">${typeLabel}</div>
      <div style="font-size:13px;font-weight:600;color:#d0d0e8;margin-bottom:4px">${escapeHtml(entity.term || entity.name || '')}</div>
      ${desc ? `<div style="font-size:11px;color:#4a4a6a;line-height:1.55">${escapeHtml(desc)}</div>` : ''}
      <span style="font-size:10px;color:#2a2a3a;float:right;margin-top:4px">${timestamp}</span>
    `;

    const key = (entity.term || entity.name || '').toLowerCase();
    addThumbsDown(card, key);
    return card;
  }

  function ensureSidebar() {
    injectMinimalStyles();

    let sidebar = document.getElementById('context-sidebar');
    let cardContainer;

    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.id = 'context-sidebar';
      sidebar.style.cssText = getSidebarCSS();

      // Header
      const header = document.createElement('div');
      header.id = 'context-sidebar-header';
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:#0e0e16;border-bottom:1px solid #1e1e2e;flex-shrink:0;';

      const wordmark = document.createElement('span');
      wordmark.style.cssText = 'font-size:13px;font-weight:500;color:#e0e0f0;letter-spacing:0.01em;';
      wordmark.textContent = 'context';

      const liveWrap = document.createElement('div');
      liveWrap.style.cssText = 'display:flex;align-items:center;gap:5px;';

      const liveDot = document.createElement('span');
      liveDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#00e676;animation:ctx-pulse 2s ease-in-out infinite;';

      const liveText = document.createElement('span');
      liveText.style.cssText = 'font-size:10px;color:#00e676;font-weight:500;';
      liveText.textContent = 'Live';

      liveWrap.appendChild(liveDot);
      liveWrap.appendChild(liveText);
      header.appendChild(wordmark);
      header.appendChild(liveWrap);

      // Empty state
      const emptyState = document.createElement('div');
      emptyState.id = 'context-sidebar-empty';
      emptyState.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0e0e16;';

      const dotsWrap = document.createElement('div');
      dotsWrap.style.cssText = 'display:flex;gap:6px;';
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.style.cssText = `width:5px;height:5px;border-radius:50%;background:#3a3a5a;animation:ctx-dot-pulse 1.4s ease-in-out infinite;animation-delay:${i * 0.2}s;`;
        dotsWrap.appendChild(dot);
      }

      const emptyText = document.createElement('div');
      emptyText.style.cssText = 'font-size:12px;color:#3a3a5a;';
      emptyText.textContent = 'Listening...';

      emptyState.appendChild(dotsWrap);
      emptyState.appendChild(emptyText);

      // Cards container
      cardContainer = document.createElement('div');
      cardContainer.id = 'context-sidebar-cards';
      cardContainer.style.cssText = 'flex:1;overflow-y:auto;padding:0;display:none;background:#0e0e16;';

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
    divider.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px;background:#0e0e16;';

    const hr1 = document.createElement('hr');
    hr1.style.cssText = 'flex:1;border:none;border-top:1px solid #1e1e2e;margin:0;';
    const span = document.createElement('span');
    span.style.cssText = 'color:#3a3a5a;font-size:10px;white-space:nowrap;';
    span.textContent = 'Session started ' + timeStr;
    const hr2 = document.createElement('hr');
    hr2.style.cssText = 'flex:1;border:none;border-top:1px solid #1e1e2e;margin:0;';

    divider.appendChild(hr1);
    divider.appendChild(span);
    divider.appendChild(hr2);

    cardContainer.prepend(divider);
    showCardsHideEmpty();
    console.log('[CONTENT] Session divider added:', timeStr);
  }

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards called, sidebar exists:', !!document.getElementById('context-sidebar'));

    const sidebar = ensureSidebar();
    console.log('[CONTENT] Sidebar element:', sidebar.id, 'bg:', sidebar.style.background, 'cssText:', sidebar.style.cssText.substring(0, 50));
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

    openSidebar(sidebar);
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
