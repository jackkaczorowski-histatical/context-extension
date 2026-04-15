(function() {
  const params = new URLSearchParams(window.location.search);
  const source = params.get('utm_source') || params.get('source') || '';
  const medium = params.get('utm_medium') || '';
  const campaign = params.get('utm_campaign') || '';
  if (source || medium || campaign) {
    chrome.storage.local.set({
      installAttribution: {
        source: source || 'organic',
        medium: medium,
        campaign: campaign,
        timestamp: new Date().toISOString()
      }
    });
  }
})();
