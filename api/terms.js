module.exports = function handler(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context — Terms of Service</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a14; color: #e0e0f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.7; padding: 48px 24px;
  }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; }
  .updated { font-size: 13px; color: #64748b; margin-bottom: 40px; }
  h2 { font-size: 16px; font-weight: 600; color: #a0a0c0; margin: 32px 0 8px; }
  p { font-size: 15px; color: #c0c0d8; margin-bottom: 16px; }
  a { color: #14b8a6; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>Context &mdash; Terms of Service</h1>
  <p class="updated">Last updated: April 7, 2026</p>

  <h2>Description of service</h2>
  <p>Context is a Chrome extension that provides real-time contextual information about audio content playing in your browser. It extracts entities, insights, and related information using AI-powered speech recognition and language processing.</p>

  <h2>User responsibilities</h2>
  <p>You are responsible for ensuring you have the right to capture audio from your browser tab. For public content such as YouTube videos, podcasts, and online courses, no additional consent is needed. For meetings, calls, or private conversations, you must ensure all participants are aware that audio is being processed. You agree not to use Context to capture audio without appropriate consent where required by law.</p>

  <h2>AI accuracy disclaimer</h2>
  <p>Context uses artificial intelligence to extract and summarize information. AI-generated content may be inaccurate, incomplete, outdated, or misleading. Information provided by Context is not a substitute for professional advice of any kind. You should independently verify any information before relying on it.</p>

  <h2>Financial data disclaimer</h2>
  <p>Stock prices, financial data, and market information displayed by Context are for informational purposes only. Prices may be delayed and may not reflect current market conditions. Nothing in Context constitutes financial advice, investment advice, or a recommendation to buy or sell any security. Do not make financial decisions based solely on information from Context.</p>

  <h2>Limitation of liability</h2>
  <p>Context is provided &ldquo;as is&rdquo; without warranties of any kind, express or implied. To the maximum extent permitted by law, Context and its developer shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the service. Total liability shall not exceed the amount you have paid for Context in the 12 months preceding the claim, or $100, whichever is greater.</p>

  <h2>Subscriptions and billing</h2>
  <p>Context offers free and paid tiers. Paid subscriptions are billed monthly or annually. You may cancel at any time &mdash; cancellation takes effect at the end of the current billing period. Annual subscribers may request a prorated refund within 30 days of purchase. Free tier usage is subject to daily limits.</p>

  <h2>Termination</h2>
  <p>You may stop using Context at any time by uninstalling the extension. We may suspend or terminate your access if you violate these terms, abuse the service, or engage in activity that harms other users or our infrastructure.</p>

  <h2>Governing law</h2>
  <p>These terms are governed by the laws of the State of New Jersey, without regard to conflict of law principles.</p>

  <h2>Age restriction</h2>
  <p>You must be at least 13 years old to use Context.</p>

  <h2>Changes to terms</h2>
  <p>We may update these terms from time to time. Continued use of Context after changes constitutes acceptance of the updated terms.</p>

  <h2>Contact</h2>
  <p>For questions about these terms, contact <a href="mailto:jack@histatical.com">jack@histatical.com</a></p>
</main>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
