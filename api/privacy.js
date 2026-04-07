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
  ul { font-size: 15px; color: #c0c0d8; margin: 0 0 16px 20px; }
  li { margin-bottom: 6px; }
  a { color: #14b8a6; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>Context &mdash; Privacy Policy</h1>
  <p class="updated">Last updated: April 7, 2026</p>

  <h2>What Context does</h2>
  <p>Context is a Chrome extension that extracts entities, insights, and contextual information from audio playing in your browser tab in real-time.</p>

  <h2>Audio processing</h2>
  <p>Tab audio is captured locally in your browser and streamed to Deepgram for speech-to-text transcription. The text transcript is then sent to Anthropic's Claude API for entity extraction and analysis. Audio is processed in real-time and is never stored on any server. Transcripts are used only for the duration of processing and are not retained by Context.</p>

  <h2>Local data storage</h2>
  <p>Extracted entities, insights, session history, knowledge base entries, and user preferences are stored in your browser's local storage (chrome.storage.local). This data stays on your device. You can view, export, or delete all stored data at any time using the sidebar controls.</p>

  <h2>User accounts</h2>
  <p>If you sign in with Google, your name, email, and profile photo are used to identify your account. Account data is stored in <a href="https://supabase.com">Supabase</a> (supabase.com), a hosted database service. Signing in is optional &mdash; the extension works fully without an account.</p>

  <h2>Anonymous analytics</h2>
  <p>If you enable &ldquo;Help improve Context&rdquo; in settings, anonymous usage events (such as session duration and entity counts) are sent to our server. These events contain no personal information, no transcript content, and no browsing history. You can disable this at any time in settings. A random anonymous install ID is generated per installation for rate limiting purposes.</p>

  <h2>Third-party services</h2>
  <p>Context uses the following third-party services:</p>
  <ul>
    <li><a href="https://deepgram.com">Deepgram</a> (deepgram.com) &mdash; speech-to-text transcription</li>
    <li><a href="https://anthropic.com">Anthropic</a> (anthropic.com) &mdash; AI entity extraction</li>
    <li><a href="https://supabase.com">Supabase</a> (supabase.com) &mdash; user account storage (if signed in)</li>
    <li><a href="https://vercel.com">Vercel</a> (vercel.com) &mdash; API hosting</li>
    <li><a href="https://upstash.com">Upstash</a> (upstash.com) &mdash; rate limiting</li>
    <li><a href="https://google.com">Google</a> (google.com) &mdash; sign-in authentication (if used)</li>
  </ul>
  <p>Data transmitted to these services is subject to their respective privacy policies.</p>

  <h2>What we do not do</h2>
  <p>We do not sell, share, or monetize your data. We do not track your browsing history. We do not store audio recordings. We do not use cookies or tracking pixels. We do not collect data from pages where you are not actively using Context.</p>

  <h2>Data retention</h2>
  <p>Audio: never stored. Transcripts: ephemeral, discarded after processing. Local data: stored until you clear it. Account data: retained while your account exists. Anonymous analytics: retained for 12 months, then deleted.</p>

  <h2>Age restriction</h2>
  <p>Context is not intended for use by anyone under the age of 13.</p>

  <h2>Your rights</h2>
  <p>You can access all your data through the extension sidebar. You can export your knowledge base and session history. You can delete all local data using the Clear button. You can delete your account by contacting us. You can opt out of analytics at any time in settings.</p>

  <h2>Contact</h2>
  <p>For questions about this privacy policy, contact <a href="mailto:jack@histatical.com">jack@histatical.com</a></p>
</main>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
