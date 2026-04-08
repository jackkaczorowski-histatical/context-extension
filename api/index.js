module.exports = function handler(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context — Real-Time AI Context Cards</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0f1a; color: #e0e0f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 48px 24px;
  }
  .container { max-width: 600px; text-align: center; }
  h1 {
    font-size: 48px; font-weight: 700; letter-spacing: -1px;
    background: linear-gradient(135deg, #14b8a6, #6366f1);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 12px;
  }
  .sub { font-size: 20px; color: #a0a0c0; margin-bottom: 32px; }
  .desc { font-size: 16px; color: #8888a8; line-height: 1.7; margin-bottom: 48px; }
  .links { font-size: 14px; color: #64748b; margin-bottom: 12px; }
  .links a { color: #14b8a6; text-decoration: none; margin: 0 8px; }
  .links a:hover { text-decoration: underline; }
  .contact { font-size: 13px; color: #4a4a6a; }
  .contact a { color: #6366f1; text-decoration: none; }
  .contact a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="container">
  <h1>Context</h1>
  <p class="sub">Real-time AI context cards for any audio on the web</p>
  <p class="desc">Context listens to any browser tab &mdash; YouTube, podcasts, Zoom, lectures &mdash; and surfaces live explanations, stock prices, and insights in a sidebar as you watch.</p>
  <p class="links"><a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p>
  <p class="contact">Contact: <a href="mailto:jack@histatical.com">jack@histatical.com</a></p>
</div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
