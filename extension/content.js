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
  let listeningTimer = null;
  let badgeEl = null;
  let badgeShadow = null;
  let termCount = 0;

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
    .ctx-empty-text { font-size: 11px; color: #3a3a5a; }
    #listening-indicator {
      display: none; align-items: center; gap: 6px;
      padding: 6px 16px; background: #0e0e16;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    #listening-indicator.visible { display: flex; }
    #listening-indicator .li-dot {
      width: 4px; height: 4px; border-radius: 50%; background: #2a2a3a;
      animation: ctx-pulse 2s ease-in-out infinite;
    }
    #listening-indicator .li-text { font-size: 10px; color: #2a2a3a; }
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
      position: relative; padding: 8px 16px 8px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.03); border-left: 2px solid #4a4a6a;
      background: #121220; animation: ctx-card-in 0.25s ease-out both;
      cursor: pointer; user-select: none;
    }
    .context-card:hover { background: #14142a; }
    @keyframes ctx-card-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .context-card.collapsed { animation: none; cursor: default; }
    .card-row {
      display: flex; align-items: center; gap: 8px;
    }
    .card-type {
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      text-transform: uppercase; flex-shrink: 0;
    }
    .card-term {
      font-size: 13px; font-weight: 600; color: #d0d0e8;
      flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .card-time { font-size: 10px; color: #2a2a3a; flex-shrink: 0; }
    .card-chevron {
      font-size: 12px; color: #3a3a5a; flex-shrink: 0;
      transition: transform 0.2s ease; line-height: 1;
    }
    .context-card.expanded .card-chevron { transform: rotate(90deg); }
    .card-expand-area { display: none; padding-top: 6px; }
    .context-card.expanded .card-expand-area { display: block; }
    .card-desc { font-size: 11px; color: #6a6a8a; line-height: 1.55; }
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
      background: #0f1a14; box-shadow: inset 2px 0 8px rgba(0, 230, 118, 0.15);
    }
    .context-card.stock-card:hover { background: #112218; }
    .stock-ticker { font-size: 18px; font-weight: 700; color: #e0e0f0; margin-bottom: 1px; }
    .stock-company { font-size: 10px; color: #3a3a5a; margin-bottom: 8px; }
    .stock-price-row { display: flex; align-items: baseline; gap: 8px; }
    .stock-price { font-size: 16px; font-weight: 600; color: #e0e0f0; }
    .stock-change { font-size: 12px; font-weight: 600; }
    .stock-change.positive { color: #00e676; }
    .stock-change.negative { color: #ff5252; }
    .card-actions {
      position: absolute; top: 8px; right: 10px; display: flex; gap: 4px;
      opacity: 0; transition: opacity 0.15s; pointer-events: none;
    }
    .context-card.expanded:hover .card-actions { opacity: 1; pointer-events: auto; }
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
      transition: color 0.15s; display: inline-block; margin-top: 4px;
    }
    .card-wiki-link:hover { color: #7a7aaa; }
    .feedback-msg { font-size: 11px; color: #3a3a5a; padding: 4px 0; text-align: center; }
  `;

  const BADGE_CSS = `
    :host { display: block; }
    .ctx-badge {
      width: 36px; height: 36px; border-radius: 50%;
      background: #1a1a2e; border: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: box-shadow 0.3s ease, border-color 0.2s;
      user-select: none;
    }
    .ctx-badge:hover {
      border-color: rgba(255,255,255,0.15);
      background: #1e1e32;
    }
    .ctx-badge.pulse {
      animation: badge-glow 1.5s ease-out;
    }
    @keyframes badge-glow {
      0% { box-shadow: 0 0 12px rgba(0,230,118,0.4); }
      100% { box-shadow: none; }
    }
    .ctx-badge-count {
      font-size: 13px; font-weight: 600; color: #e0e0f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1;
    }
  `;

  function ensureBadge() {
    if (badgeShadow) return;

    badgeEl = document.createElement('div');
    badgeEl.id = 'context-badge-host';
    badgeEl.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';

    badgeShadow = badgeEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    badgeShadow.appendChild(style);

    const badge = document.createElement('div');
    badge.className = 'ctx-badge';
    badge.innerHTML = '<span class="ctx-badge-count">0</span>';
    badge.addEventListener('click', () => {
      if (!hostEl) return;
      if (hostEl.dataset.open === 'true') {
        closeSidebar();
      } else {
        openSidebar();
        resetAutoHide();
      }
    });
    badgeShadow.appendChild(badge);
    document.body.appendChild(badgeEl);
  }

  function updateBadge(newCards) {
    if (!badgeShadow) return;
    const countEl = badgeShadow.querySelector('.ctx-badge-count');
    if (countEl) countEl.textContent = termCount;

    if (newCards > 0) {
      const badge = badgeShadow.querySelector('.ctx-badge');
      if (badge) {
        badge.classList.remove('pulse');
        void badge.offsetWidth;
        badge.classList.add('pulse');
      }
    }
  }

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
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
    card.className = 'context-card stock-card expanded';
    const color = getTypeColor('stock');
    card.style.borderLeftColor = color;

    const ticker = escapeHtml(entity.ticker || '');
    const companyName = escapeHtml(entity.companyName || entity.name || '');
    const timestamp = formatTime(new Date());

    let expandContent;
    if (entity.price != null && entity.price !== '') {
      const price = parseFloat(entity.price);
      const changeVal = parseFloat(entity.change) || 0;
      const changeClass = changeVal >= 0 ? 'positive' : 'negative';
      const changePrefix = changeVal >= 0 ? '+' : '';
      expandContent = `
        <div class="stock-company">${companyName}</div>
        <div class="stock-price-row">
          <span class="stock-price">$${price.toFixed(2)}</span>
          <span class="stock-change ${changeClass}">${changePrefix}${changeVal.toFixed(2)}</span>
        </div>
      `;
    } else {
      expandContent = `
        <div class="stock-company">${companyName}</div>
        ${entity.description ? `<div class="card-desc">${escapeHtml(firstSentence(entity.description))}</div>` : ''}
      `;
    }

    card.innerHTML = `
      <div class="card-row">
        <span class="card-type" style="color:${color}">STOCK</span>
        <span class="card-term">${ticker}</span>
        <span class="card-time">${timestamp}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      <div class="card-expand-area">${expandContent}</div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a')) return;
      card.classList.toggle('expanded');
    });

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
    const typeLabel = (type || 'OTHER').toUpperCase();
    const termText = escapeHtml(entity.term || entity.name || '');

    const wikiTerm = (entity.term || entity.name || '').replace(/ /g, '_');
    const wikiUrl = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(wikiTerm);

    card.innerHTML = `
      <div class="card-row">
        <span class="card-type" style="color:${color}">${typeLabel}</span>
        <span class="card-term">${termText}</span>
        <span class="card-time">${timestamp}</span>
        <span class="card-chevron">&#x203A;</span>
      </div>
      <div class="card-expand-area">
        <div class="card-desc"></div>
        <a class="card-wiki-link" href="${wikiUrl}" target="_blank" rel="noopener">Wikipedia &#x2197;</a>
      </div>
    `;

    let descFetched = false;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions') || e.target.closest('a')) return;
      card.classList.toggle('expanded');

      if (card.classList.contains('expanded') && !descFetched) {
        descFetched = true;
        const descEl = card.querySelector('.card-desc');
        descEl.classList.add('card-desc-loading');

        chrome.storage.local.get('userProfile', (data) => {
          fetch('https://context-extension-zv8d.vercel.app/api/context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              term: entity.term || entity.name || '',
              userProfile: data.userProfile || null
            })
          })
          .then(res => res.ok ? res.json() : Promise.reject(res))
          .then(contextData => {
            descEl.classList.remove('card-desc-loading');
            const desc = firstSentence(contextData.description || '');
            descEl.textContent = desc;
            // Update sessionHistory with description
            const termName = entity.term || entity.name || '';
            chrome.storage.local.get('sessionHistory', (hData) => {
              const history = hData.sessionHistory || [];
              const entry = history.find(h => h.term === termName && !h.description);
              if (entry) {
                entry.description = desc;
                chrome.storage.local.set({ sessionHistory: history });
              }
            });
          })
          .catch(() => {
            descEl.classList.remove('card-desc-loading');
            descEl.textContent = 'Could not load description';
          });
        });
      }
    });

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
      <div class="ctx-waveform"><span></span><span></span><span></span><span></span></div>
      <div class="ctx-empty-text">Listening for context...</div>
    `;

    // Listening indicator
    const listeningIndicator = document.createElement('div');
    listeningIndicator.id = 'listening-indicator';
    listeningIndicator.innerHTML = '<span class="li-dot"></span><span class="li-text">Listening for new terms...</span>';

    // Cards container
    const cardContainer = document.createElement('div');
    cardContainer.id = 'cards';

    sidebar.appendChild(header);
    sidebar.appendChild(listeningIndicator);
    sidebar.appendChild(emptyState);
    sidebar.appendChild(cardContainer);
    shadowRoot.appendChild(sidebar);
    document.body.appendChild(hostEl);

    ensureBadge();
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

    // Split into highlights (shown in sidebar) and background (recap only)
    const highlights = entities.filter(e => e.salience !== 'background');
    const background = entities.filter(e => e.salience === 'background');

    // Store background entities in sessionHistory only
    if (background.length > 0) {
      chrome.storage.local.get('sessionHistory', (hData) => {
        const history = hData.sessionHistory || [];
        background.forEach(e => {
          const term = e.term || e.name || '';
          if (term) history.push({ term, type: e.type || 'other', timestamp: Date.now(), description: '', salience: 'background' });
        });
        chrome.storage.local.set({ sessionHistory: history });
      });
      termCount += background.length;
      console.log('[CONTENT] Stored', background.length, 'background entities for recap');
    }

    if (highlights.length > 0) {
      showCardsHideEmpty();

      // Hide listening indicator and reset timer
      if (shadowRoot) {
        const li = shadowRoot.getElementById('listening-indicator');
        if (li) li.classList.remove('visible');
      }
      if (listeningTimer) clearTimeout(listeningTimer);
      listeningTimer = setTimeout(() => {
        if (shadowRoot && hasCards) {
          const li = shadowRoot.getElementById('listening-indicator');
          if (li) li.classList.add('visible');
        }
      }, 20000);

      const limited = highlights.slice(0, settings.cardsPerChunk);

      limited.forEach(entity => {
        const card = entity.type === 'stock'
          ? createStockCard(entity)
          : createGenericCard(entity);

        cards.prepend(card);
        termCount++;
        console.log('[CONTENT] Card added:', entity.ticker || entity.term || entity.name);
      });

      updateBadge(limited.length);
    } else {
      // Still update badge count for background entities but don't pulse
      updateBadge(0);
    }

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

  // --- Auto-capture: detect playing media on any site ---
  const isYouTube = window.location.hostname.includes('youtube.com') && window.location.pathname === '/watch';
  let autoCapturing = false;
  let autoPaused = false;
  let autoStartDebounce = null;

  function isLongMedia(el) {
    return el.duration && el.duration > 60;
  }

  function anyMediaPlaying() {
    const els = document.querySelectorAll('video, audio');
    for (const el of els) {
      if (!el.paused && !el.ended && el.dataset.ctxAttached && isLongMedia(el)) return true;
    }
    return false;
  }

  function handleMediaPlay(el) {
    if (!chrome.runtime?.id) return;
    if (!isLongMedia(el)) {
      console.log('[CONTENT] Ignoring short media element, duration:', el.duration);
      return;
    }

    if (!autoCapturing) {
      // Debounce to avoid ads
      if (autoStartDebounce) clearTimeout(autoStartDebounce);
      autoStartDebounce = setTimeout(() => {
        autoStartDebounce = null;
        // Re-check the element is still playing and long enough
        if (el.paused || el.ended || !isLongMedia(el)) return;
        if (autoCapturing) return;
        autoCapturing = true;
        autoPaused = false;
        console.log('[CONTENT] Media playing, auto-starting capture');
        chrome.runtime.sendMessage({ type: 'START_CAPTURE' });
        chrome.storage.local.set({ capturing: true });
      }, 2000);
    } else if (autoPaused) {
      autoPaused = false;
      console.log('[CONTENT] Media resumed');
      chrome.runtime.sendMessage({ type: 'RESUME_CAPTURE' });
    }
  }

  function handleMediaPause() {
    if (!autoCapturing || autoPaused) return;
    if (!chrome.runtime?.id) return;
    // Check if any other tracked media is still playing
    if (anyMediaPlaying()) return;
    autoPaused = true;
    console.log('[CONTENT] All media paused');
    chrome.runtime.sendMessage({ type: 'PAUSE_CAPTURE' });
  }

  function handleMediaEnded() {
    if (!chrome.runtime?.id) return;
    // Check if any other tracked media is still playing
    if (anyMediaPlaying()) return;
    if (!autoCapturing) return;
    autoCapturing = false;
    autoPaused = false;
    console.log('[CONTENT] All media ended, stopping capture');
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    chrome.storage.local.set({ capturing: false });
  }

  function attachMediaListeners(el) {
    if (el.dataset.ctxAttached) return;
    el.dataset.ctxAttached = 'true';
    const tag = el.tagName.toLowerCase();
    console.log('[CONTENT] Attaching listeners to', tag, 'element');

    el.addEventListener('play', () => handleMediaPlay(el));
    el.addEventListener('pause', () => handleMediaPause());
    el.addEventListener('ended', () => handleMediaEnded());

    // YouTube-specific: seek detection
    if (isYouTube) {
      el.addEventListener('seeked', () => {
        if (!autoCapturing) return;
        if (!chrome.runtime?.id) return;
        console.log('[CONTENT] Media seeked, clearing buffer');
        chrome.runtime.sendMessage({ type: 'SEEK_DETECTED' });
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
