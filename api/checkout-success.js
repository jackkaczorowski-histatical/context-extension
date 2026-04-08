module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html><html><head><title>Context Pro - Success!</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0f1a;color:#e2e8f0;}div{text-align:center;max-width:400px;padding:40px;}h1{color:#00e676;margin-bottom:16px;}p{color:#94a3b8;line-height:1.6;}</style></head><body><div><h1>Welcome to Context Pro! \u2713</h1><p>Your subscription is active. Return to YouTube and start listening \u2014 your Pro features are unlocked.</p><p style="margin-top:24px;font-size:14px;color:#64748b;">You can close this tab.</p></div></body></html>`);
};
