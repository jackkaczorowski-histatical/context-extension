console.log('CONTENT SCRIPT LOADED');

if (!window.__contextExtensionLoaded) {
  window.__contextExtensionLoaded = true;

  const seenTerms = {}; // term -> timestamp
  const DEDUP_WINDOW = 600000; // 10 minutes

  function renderCards(entities) {
    if (!entities || entities.length === 0) return;
    console.log('[CONTENT] renderCards:', entities.length, 'entities');

    let sidebar = document.getElementById('context-sidebar');
    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.id = 'context-sidebar';
      sidebar.style.cssText = 'position:fixed;top:0;right:0;width:380px;height:100vh;background:#1a1a1a;z-index:2147483647;overflow-y:auto;color:white;font-family:Arial;';
      document.body.appendChild(sidebar);
      console.log('[CONTENT] Sidebar created');
    }

    const now = Date.now();
    // Clean expired entries
    Object.keys(seenTerms).forEach(key => {
      if (now - seenTerms[key] > DEDUP_WINDOW) delete seenTerms[key];
    });

    entities = entities.filter(entity => {
      const key = (entity.ticker || entity.term || entity.name || '').toLowerCase();
      if (!key) return false;
      if (seenTerms[key] && now - seenTerms[key] < DEDUP_WINDOW) {
        console.log('[CONTENT] Dedup skipped:', key);
        return false;
      }
      seenTerms[key] = now;
      return true;
    });

    if (entities.length === 0) return;

    entities.forEach(entity => {
      const card = document.createElement('div');
      card.style.cssText = 'padding:16px;border-bottom:1px solid #333;';

      const term = entity.ticker || entity.term || entity.name || '';
      const detail = entity.type === 'stock'
        ? `$${parseFloat(entity.price || 0).toFixed(2)} (${parseFloat(entity.change || 0) >= 0 ? '+' : ''}${parseFloat(entity.change || 0).toFixed(2)})`
        : (entity.description || '');

      card.innerHTML = `<div style="font-weight:bold;margin-bottom:4px;">${term}</div><div style="font-size:13px;color:#aaa;">${detail}</div>`;
      sidebar.prepend(card);
      console.log('[CONTENT] Card added:', term);
    });

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
