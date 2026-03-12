if (!window.__contextExtensionLoaded) {
  window.__contextExtensionLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'CONTEXT_DATA') return;
    console.log('CONTEXT_DATA RECEIVED', message.entities);

    let sidebar = document.getElementById('context-sidebar');
    if (!sidebar) {
      sidebar = document.createElement('div');
      sidebar.id = 'context-sidebar';
      sidebar.style.cssText = 'position:fixed;top:0;right:0;width:380px;height:100vh;background:#1a1a1a;z-index:2147483647;overflow-y:auto;color:white;font-family:Arial;';
      document.body.appendChild(sidebar);
    }

    (message.entities || []).forEach(entity => {
      const card = document.createElement('div');
      card.style.cssText = 'padding:16px;border-bottom:1px solid #333;';

      const term = entity.ticker || entity.term || entity.name || '';
      const detail = entity.type === 'stock'
        ? `$${parseFloat(entity.price || 0).toFixed(2)} (${parseFloat(entity.change || 0) >= 0 ? '+' : ''}${parseFloat(entity.change || 0).toFixed(2)})`
        : (entity.description || '');

      card.innerHTML = `<div style="font-weight:bold;margin-bottom:4px;">${term}</div><div style="font-size:13px;color:#aaa;">${detail}</div>`;
      sidebar.prepend(card);
    });
  });
}
