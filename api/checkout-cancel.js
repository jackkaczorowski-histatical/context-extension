module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html><html><head><title>Context - Checkout Canceled</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0f1a;color:#e2e8f0;}div{text-align:center;max-width:400px;padding:40px;}p{color:#94a3b8;line-height:1.6;}</style></head><body><div><p>Checkout was canceled. No charge was made.</p><p style="margin-top:16px;font-size:14px;color:#64748b;">You can close this tab and continue using Context Free.</p></div></body></html>`);
};
