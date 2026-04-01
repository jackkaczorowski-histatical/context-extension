module.exports = function handler(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context — Privacy Policy</title>
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
  <h1>Context &mdash; Privacy Policy</h1>
  <p class="updated">Last updated: April 1, 2026</p>

  <h2>What Context does</h2>
  <p>Context is a Chrome extension that extracts entities, insights, and contextual information from audio playing in your browser tab in real-time.</p>

  <h2>Audio processing</h2>
  <p>Tab audio is captured locally in your browser and streamed to Deepgram for speech-to-text transcription. The text transcript is then sent to Anthropic's Claude API for entity extraction and analysis. Audio is processed in real-time and is NOT stored on any server.</p>

  <h2>Data storage</h2>
  <p>All extracted entities, insights, session history, and user preferences are stored exclusively in your browser's local storage (chrome.storage.local). No user data is sent to or stored on any external server. You can clear all stored data at any time using the Clear button in the sidebar.</p>

  <h2>Third-party services</h2>
  <p>Context uses two third-party services to function: <a href="https://deepgram.com">Deepgram</a> for speech-to-text transcription, and <a href="https://anthropic.com">Anthropic</a> for AI-powered entity extraction. Audio and transcript data is transmitted to these services for processing only and is subject to their respective privacy policies.</p>

  <h2>No tracking</h2>
  <p>Context does not use cookies, analytics, tracking pixels, or any form of user tracking. We do not collect, store, or sell any personal information.</p>

  <h2>Contact</h2>
  <p>For questions about this privacy policy, contact <a href="mailto:jack@histatical.com">jack@histatical.com</a></p>
</main>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
