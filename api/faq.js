module.exports = function handler(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context — FAQ</title>
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
  a { color: #14b8a6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .faq-item { border-bottom: 1px solid rgba(255,255,255,0.06); }
  .faq-q {
    font-size: 15px; color: #e2e8f0; padding: 16px 0; cursor: pointer;
    display: flex; justify-content: space-between; align-items: center;
    user-select: none;
  }
  .faq-q:hover { color: #14b8a6; }
  .faq-q::after { content: '+'; font-size: 18px; color: #64748b; flex-shrink: 0; margin-left: 16px; }
  .faq-item.open .faq-q::after { content: '\\2212'; }
  .faq-a {
    font-size: 15px; color: #c0c0d8; padding: 0 0 16px;
    display: none; line-height: 1.7;
  }
  .faq-item.open .faq-a { display: block; }
</style>
</head>
<body>
<main>
  <h1>Context &mdash; FAQ</h1>
  <p class="updated">Last updated: April 9, 2026</p>

  <h2>Getting started</h2>

  <div class="faq-item">
    <div class="faq-q">How do I use Context?</div>
    <div class="faq-a">Open any YouTube video, click the Context icon in your toolbar, then click the play button to start listening. Context cards will appear as the video mentions people, companies, concepts, and more.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">What websites does Context work on?</div>
    <div class="faq-a">Context works on YouTube, Spotify, Twitch, Coursera, Khan Academy, Udemy, SoundCloud, Netflix, and Google Podcasts. Any site that plays audio in the browser tab.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Do I need headphones?</div>
    <div class="faq-a">No. Context captures audio directly from the browser tab, not your microphone. Headphones or speakers both work fine.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Does it work on Zoom or Google Meet?</div>
    <div class="faq-a">Yes, if you join the meeting in your browser (not the desktop app). Context captures any audio playing in a Chrome tab.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Why do I need to sign in with Google?</div>
    <div class="faq-a">Sign-in lets us sync your subscription status, save your knowledge base across sessions, and provide account support. We only store your name and email.</div>
  </div>

  <h2>Features</h2>

  <div class="faq-item">
    <div class="faq-q">What are entity cards?</div>
    <div class="faq-a">Cards are real-time explanations that appear when the video mentions a notable person, company, concept, stock, event, or technical term. Each card has a short description, follow-up questions, and links to learn more.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">How do stock price cards work?</div>
    <div class="faq-a">When a publicly traded company or ETF is mentioned, Context automatically looks up the current stock price, daily change, 52-week range, and volume. Prices may be delayed. This is not financial advice.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">What is the Knowledge Base?</div>
    <div class="faq-a">A personal record of every term you&rsquo;ve encountered across all sessions. It grows over time and helps Context show you only what&rsquo;s new &mdash; terms you&rsquo;ve already seen are deprioritized.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Can I export my session notes?</div>
    <div class="faq-a">Yes. Click Export in the sidebar to copy a study guide to your clipboard or download it as a text file. The export includes all entities, insights, and follow-up questions from your session.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">What is &ldquo;Tell me more&rdquo;?</div>
    <div class="faq-a">Click &ldquo;Tell me more&rdquo; on any card to ask Context a follow-up question about that entity in the context of the video you&rsquo;re watching. The AI will give a detailed answer based on the video content.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">What are Insights?</div>
    <div class="faq-a">Insights are practical takeaways, techniques, and &ldquo;why&rdquo; moments extracted from the video &mdash; things a learner would want to remember that aren&rsquo;t specific named terms.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Can I go back and review past sessions?</div>
    <div class="faq-a">Yes. Click History in the sidebar to see all past sessions with their entities and insights. You can expand any session to review or export it.</div>
  </div>

  <h2>Troubleshooting</h2>

  <div class="faq-item">
    <div class="faq-q">No cards are appearing.</div>
    <div class="faq-a">Wait at least 45 seconds &mdash; some content takes time. If nothing appears, the video may not contain identifiable terms. Try a video about specific topics, people, or companies. If the issue persists, try refreshing the page or restarting the extension.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">I see a &ldquo;Connection error&rdquo; message.</div>
    <div class="faq-a">Check your internet connection. Context needs an active connection to process audio. Try refreshing the page.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Audio isn&rsquo;t being captured.</div>
    <div class="faq-a">Make sure the tab is playing audio and isn&rsquo;t muted. Try refreshing the page. If using Zoom or Meet, ensure you&rsquo;re in the browser version, not the desktop app.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">The extension isn&rsquo;t showing on a website.</div>
    <div class="faq-a">Context only activates on supported websites (YouTube, Spotify, Twitch, etc.). Make sure the extension is enabled in chrome://extensions and pinned to your toolbar.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Cards stopped appearing mid-session.</div>
    <div class="faq-a">The AI may be processing a dense segment. Wait 15 seconds. If nothing appears, try stopping and restarting capture. If it persists, refresh the page.</div>
  </div>

  <h2>Account &amp; billing</h2>

  <div class="faq-item">
    <div class="faq-q">Is Context free?</div>
    <div class="faq-a">Yes, for 30 minutes per day. Upgrade to Pro for unlimited listening time, plus full access to session history, knowledge base exports, and follow-up questions.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">How much does Pro cost?</div>
    <div class="faq-a">$12/month or $84/year. You can manage or cancel your subscription at any time from Settings.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">How do I cancel my subscription?</div>
    <div class="faq-a">Open the sidebar, go to Settings, and click &ldquo;Manage Subscription.&rdquo; This opens the Stripe billing portal where you can cancel. Your access continues until the end of the current billing period.</div>
  </div>

  <h2>Privacy</h2>

  <div class="faq-item">
    <div class="faq-q">What data does Context collect?</div>
    <div class="faq-a">Context processes audio in real time to extract entities. Audio is streamed to Deepgram for transcription and never stored. Transcript text is sent to Anthropic&rsquo;s Claude AI for entity extraction and is not retained. We store your account info, session history, and anonymous usage analytics. See our full <a href="/privacy">Privacy Policy</a> for details.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Is my audio recorded or stored?</div>
    <div class="faq-a">No. Audio is streamed in real time and discarded immediately after transcription. Nothing is saved.</div>
  </div>

  <div class="faq-item">
    <div class="faq-q">Who processes my data?</div>
    <div class="faq-a">Deepgram (transcription), Anthropic (entity extraction), Supabase (account data), and Stripe (payments). No data is sold to third parties. See our <a href="/privacy">Privacy Policy</a> for full details.</div>
  </div>

</main>
<script>
  document.querySelectorAll('.faq-q').forEach(function(q) {
    q.addEventListener('click', function() {
      this.parentElement.classList.toggle('open');
    });
  });
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
