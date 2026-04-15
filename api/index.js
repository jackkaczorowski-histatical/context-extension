module.exports = function handler(req, res) {
  const CWS_URL = 'https://chromewebstore.google.com/detail/context/PLACEHOLDER';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="/icon32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icon16.png">
<title>Context — AI context cards for anything you watch</title>
<meta name="description" content="Context listens to any browser tab and surfaces live AI-powered cards explaining people, companies, stocks, and concepts as you watch.">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    background: #0a0f1a; color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6; -webkit-font-smoothing: antialiased;
  }
  a { color: #00e676; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
  section { padding: 80px 0; }

  /* Header */
  header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    background: rgba(10,15,26,0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .header-inner {
    max-width: 1100px; margin: 0 auto; padding: 0 24px;
    display: flex; align-items: center; justify-content: space-between; height: 64px;
  }
  .logo { font-size: 20px; font-weight: 700; color: #00e676; }
  nav { display: flex; gap: 32px; }
  nav a { color: #94a3b8; font-size: 14px; font-weight: 500; text-decoration: none; transition: color 0.2s; }
  nav a:hover { color: #e2e8f0; text-decoration: none; }
  .mobile-toggle { display: none; background: none; border: none; color: #94a3b8; font-size: 24px; cursor: pointer; }

  /* Hero */
  .hero { padding: 140px 0 80px; text-align: center; }
  .hero h1 { font-size: 52px; font-weight: 800; line-height: 1.15; margin-bottom: 20px; letter-spacing: -1px; }
  .hero .sub { font-size: 18px; color: #94a3b8; max-width: 620px; margin: 0 auto 36px; line-height: 1.7; }
  .hero-ctas { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; margin-bottom: 16px; }
  .btn-primary {
    display: inline-block; padding: 14px 32px; background: #00e676; color: #0a0f1a;
    font-size: 16px; font-weight: 700; border-radius: 8px; border: none; cursor: pointer;
    transition: background 0.2s, transform 0.15s; text-decoration: none;
  }
  .btn-primary:hover { background: #00c853; transform: translateY(-1px); text-decoration: none; }
  .btn-outline {
    display: inline-block; padding: 14px 32px; background: transparent; color: #e2e8f0;
    font-size: 16px; font-weight: 600; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
    cursor: pointer; transition: border-color 0.2s, background 0.2s; text-decoration: none;
  }
  .btn-outline:hover { border-color: rgba(255,255,255,0.3); background: rgba(255,255,255,0.04); text-decoration: none; }
  .hero-note { font-size: 13px; color: #64748b; }
  .hero-mockup {
    max-width: 720px; margin: 48px auto 0; aspect-ratio: 16/9; background: #111827;
    border-radius: 12px; border: 1px solid rgba(255,255,255,0.08);
    display: flex; align-items: center; justify-content: center; color: #475569; font-size: 16px;
  }

  /* Section headings */
  .section-title { font-size: 36px; font-weight: 700; text-align: center; margin-bottom: 16px; letter-spacing: -0.5px; }
  .section-sub { font-size: 16px; color: #94a3b8; text-align: center; max-width: 540px; margin: 0 auto 56px; }

  /* How it works */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; }
  .step { text-align: center; }
  .step-icon { font-size: 40px; margin-bottom: 16px; display: block; }
  .step h3 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
  .step p { font-size: 15px; color: #94a3b8; line-height: 1.6; }

  /* Features */
  .features-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  .feature-card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 28px;
  }
  .feature-card:hover { border-color: rgba(0,230,118,0.15); }
  .feature-icon { font-size: 28px; margin-bottom: 12px; display: block; }
  .feature-card h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .feature-card p { font-size: 14px; color: #94a3b8; line-height: 1.6; }

  /* Use cases */
  .use-cases { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; }
  .use-card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px; padding: 28px; text-align: center;
  }
  .use-card:hover { border-color: rgba(0,230,118,0.15); }
  .use-icon { font-size: 32px; margin-bottom: 12px; display: block; }
  .use-card h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .use-card p { font-size: 14px; color: #94a3b8; line-height: 1.6; }

  /* Pricing */
  .pricing-cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 32px; max-width: 720px; margin: 0 auto; }
  .price-card {
    background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
    border-radius: 16px; padding: 36px; text-align: center;
  }
  .price-card.featured { border-color: rgba(0,230,118,0.3); }
  .price-card h3 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  .price-amount { font-size: 42px; font-weight: 800; margin: 16px 0 4px; }
  .price-amount span { font-size: 16px; font-weight: 400; color: #94a3b8; }
  .price-alt { font-size: 13px; color: #64748b; margin-bottom: 24px; }
  .price-features { list-style: none; text-align: left; margin-bottom: 28px; }
  .price-features li { font-size: 14px; color: #94a3b8; padding: 6px 0; display: flex; align-items: center; gap: 10px; }
  .price-features li::before { content: '\\2713'; color: #00e676; font-weight: 700; font-size: 14px; flex-shrink: 0; }
  .price-cta { display: block; width: 100%; padding: 14px; border-radius: 8px; font-size: 16px; font-weight: 700; text-align: center; cursor: pointer; transition: background 0.2s; text-decoration: none; }
  .price-cta.primary { background: #00e676; color: #0a0f1a; border: none; }
  .price-cta.primary:hover { background: #00c853; text-decoration: none; }
  .price-cta.outline { background: transparent; color: #e2e8f0; border: 1px solid rgba(255,255,255,0.15); }
  .price-cta.outline:hover { border-color: rgba(255,255,255,0.3); text-decoration: none; }

  /* FAQ preview */
  .faq-list { max-width: 680px; margin: 0 auto; }
  .faq-item { border-bottom: 1px solid rgba(255,255,255,0.06); }
  .faq-q {
    font-size: 16px; color: #e2e8f0; padding: 20px 0; cursor: pointer;
    display: flex; justify-content: space-between; align-items: center; user-select: none;
  }
  .faq-q:hover { color: #00e676; }
  .faq-q::after { content: '+'; font-size: 20px; color: #64748b; flex-shrink: 0; margin-left: 16px; transition: transform 0.2s; }
  .faq-item.open .faq-q::after { content: '\\2212'; }
  .faq-a { font-size: 15px; color: #94a3b8; padding: 0 0 20px; display: none; line-height: 1.7; }
  .faq-item.open .faq-a { display: block; }
  .faq-more { text-align: center; margin-top: 32px; }
  .faq-more a { font-size: 15px; font-weight: 600; }

  /* Footer */
  footer {
    border-top: 1px solid rgba(255,255,255,0.06); padding: 32px 0;
  }
  .footer-inner {
    max-width: 1100px; margin: 0 auto; padding: 0 24px;
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;
  }
  .footer-logo { font-size: 18px; font-weight: 700; color: #00e676; }
  .footer-links { display: flex; gap: 24px; flex-wrap: wrap; }
  .footer-links a { color: #64748b; font-size: 13px; text-decoration: none; }
  .footer-links a:hover { color: #e2e8f0; }
  .footer-copy { font-size: 13px; color: #475569; }

  /* Fade-in animation */
  .fade-in { opacity: 0; transform: translateY(24px); transition: opacity 0.6s ease, transform 0.6s ease; }
  .fade-in.visible { opacity: 1; transform: translateY(0); }

  /* Responsive */
  @media (max-width: 768px) {
    .hero { padding: 120px 0 60px; }
    .hero h1 { font-size: 32px; }
    .hero .sub { font-size: 16px; }
    .steps { grid-template-columns: 1fr; gap: 32px; }
    .features-grid { grid-template-columns: 1fr; }
    .use-cases { grid-template-columns: 1fr 1fr; }
    .pricing-cards { grid-template-columns: 1fr; }
    nav { display: none; position: absolute; top: 64px; left: 0; right: 0; background: rgba(10,15,26,0.95); flex-direction: column; gap: 0; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    nav.open { display: flex; }
    nav a { padding: 12px 24px; }
    .mobile-toggle { display: block; }
    .footer-inner { flex-direction: column; text-align: center; }
    section { padding: 60px 0; }
    .section-title { font-size: 28px; }
  }
  @media (max-width: 480px) {
    .hero h1 { font-size: 28px; }
    .use-cases { grid-template-columns: 1fr; }
    .hero-ctas { flex-direction: column; align-items: center; }
  }
</style>
</head>
<body>

<header>
  <div class="header-inner">
    <div class="logo">Context</div>
    <button class="mobile-toggle" aria-label="Menu">&#9776;</button>
    <nav>
      <a href="#features">Features</a>
      <a href="#how-it-works">How It Works</a>
      <a href="#pricing">Pricing</a>
      <a href="/faq">FAQ</a>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="container">
    <h1>AI context cards for<br>anything you watch</h1>
    <p class="sub">Context listens to any browser tab &mdash; YouTube, podcasts, Zoom, lectures &mdash; and surfaces live explanations, stock prices, and insights in a sidebar as you watch.</p>
    <div class="hero-ctas">
      <a href="${CWS_URL}" class="btn-primary">Add to Chrome &mdash; Free</a>
      <a href="#how-it-works" class="btn-outline">See how it works</a>
    </div>
    <p class="hero-note">Free for 30 min/day. No credit card required.</p>
    <div style="display:block;width:100%;max-width:720px;margin:48px auto 0;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.4);aspect-ratio:16/9;">
      <iframe width="100%" height="100%" src="https://www.youtube.com/embed/_SxnJBzo-D8?rel=0&modestbranding=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="border-radius:12px;"></iframe>
    </div>
  </div>
</section>

<section id="how-it-works">
  <div class="container fade-in">
    <h2 class="section-title">How it works</h2>
    <p class="section-sub">Three steps to real-time understanding.</p>
    <div class="steps">
      <div class="step">
        <span class="step-icon">&#9654;</span>
        <h3>Hit play on any video</h3>
        <p>Open YouTube, a podcast, Zoom, or any site with audio. Click the Context icon.</p>
      </div>
      <div class="step">
        <span class="step-icon">&#10024;</span>
        <h3>Cards appear in real time</h3>
        <p>As the content mentions people, companies, stocks, and concepts, cards appear in a sidebar with instant explanations.</p>
      </div>
      <div class="step">
        <span class="step-icon">&#127891;</span>
        <h3>Learn and export</h3>
        <p>Expand cards for follow-up questions, build a knowledge base, and export study guides.</p>
      </div>
    </div>
  </div>
</section>

<section id="features">
  <div class="container fade-in">
    <h2 class="section-title">Everything you need to understand what you watch</h2>
    <div class="features-grid">
      <div class="feature-card">
        <span class="feature-icon">&#128196;</span>
        <h3>Real-time entity cards</h3>
        <p>People, companies, concepts, events, and technical terms explained as they're mentioned.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">&#128200;</span>
        <h3>Live stock prices</h3>
        <p>When a public company is mentioned, see the current price, daily change, and 52-week range.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">&#128172;</span>
        <h3>AI follow-up questions</h3>
        <p>Click &ldquo;Tell me more&rdquo; on any card to ask a question about the entity in the video&rsquo;s context.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">&#128161;</span>
        <h3>Insight extraction</h3>
        <p>Key takeaways, techniques, and &ldquo;why&rdquo; moments are captured as insight cards alongside entities.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">&#129504;</span>
        <h3>Knowledge Base</h3>
        <p>Terms you've encountered are tracked across sessions. Context learns what you know and prioritizes what&rsquo;s new.</p>
      </div>
      <div class="feature-card">
        <span class="feature-icon">&#128221;</span>
        <h3>Study guide export</h3>
        <p>Copy or download a complete study guide with entities, insights, and follow-up questions in one click.</p>
      </div>
    </div>
  </div>
</section>

<section id="use-cases">
  <div class="container fade-in">
    <h2 class="section-title">Built for curious minds</h2>
    <div class="use-cases">
      <div class="use-card">
        <span class="use-icon">&#127891;</span>
        <h3>Students</h3>
        <p>Turn any lecture or educational video into a study guide with key terms and insights automatically captured.</p>
      </div>
      <div class="use-card">
        <span class="use-icon">&#128200;</span>
        <h3>Investors</h3>
        <p>Follow finance commentary with live stock prices, company context, and market concepts explained in real time.</p>
      </div>
      <div class="use-card">
        <span class="use-icon">&#127911;</span>
        <h3>Podcast listeners</h3>
        <p>Catch every reference, person, and concept mentioned without pausing or Googling.</p>
      </div>
      <div class="use-card">
        <span class="use-icon">&#128188;</span>
        <h3>Professionals</h3>
        <p>Get real-time context during Zoom calls, webinars, and presentations running in Chrome.</p>
      </div>
    </div>
  </div>
</section>

<section id="pricing">
  <div class="container fade-in">
    <h2 class="section-title">Simple pricing</h2>
    <p class="section-sub">Start free. Upgrade when you need more.</p>
    <div class="pricing-cards">
      <div class="price-card">
        <h3>Free</h3>
        <div class="price-amount">$0<span>/month</span></div>
        <div class="price-alt">&nbsp;</div>
        <ul class="price-features">
          <li>30 minutes per day</li>
          <li>Real-time context cards</li>
          <li>Session history</li>
        </ul>
        <a href="${CWS_URL}" class="price-cta outline">Add to Chrome</a>
      </div>
      <div class="price-card featured">
        <h3>Pro</h3>
        <div class="price-amount">$12<span>/month</span></div>
        <div class="price-alt">or $84/year (save 30%)</div>
        <ul class="price-features">
          <li>Unlimited listening time</li>
          <li>Full session history</li>
          <li>Knowledge base exports</li>
          <li>Follow-up questions</li>
          <li>Priority support</li>
        </ul>
        <a href="${CWS_URL}" class="price-cta primary">Add to Chrome</a>
      </div>
    </div>
  </div>
</section>

<section id="faq-preview">
  <div class="container fade-in">
    <h2 class="section-title">Questions?</h2>
    <div class="faq-list">
      <div class="faq-item">
        <div class="faq-q">What websites does it work on?</div>
        <div class="faq-a">Context works on any website with audio content in the browser &mdash; YouTube, Spotify, Twitch, Coursera, Khan Academy, Udemy, SoundCloud, Netflix, Google Podcasts, Zoom, Google Meet, and more. If a Chrome tab can play audio, Context can listen.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">Do I need headphones?</div>
        <div class="faq-a">No. Context captures audio directly from the browser tab, not your microphone. Headphones or speakers both work fine.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">Is my audio recorded or stored?</div>
        <div class="faq-a">No. Audio is streamed in real time and discarded immediately after transcription. Nothing is saved.</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">How do I cancel Pro?</div>
        <div class="faq-a">Open the sidebar, go to Settings, and click &ldquo;Manage Subscription.&rdquo; This opens the Stripe billing portal where you can cancel. Access continues until the end of your billing period.</div>
      </div>
    </div>
    <div class="faq-more"><a href="/faq">See all FAQs &rarr;</a></div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">Context</div>
    <div class="footer-links">
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="/faq">FAQ</a>
      <a href="mailto:jack@histatical.com">Support</a>
    </div>
    <div class="footer-copy">&copy; 2026 Histatical, LLC</div>
  </div>
</footer>

<script>
  // Mobile menu toggle
  document.querySelector('.mobile-toggle').addEventListener('click', function() {
    document.querySelector('nav').classList.toggle('open');
  });
  // Close mobile menu on link click
  document.querySelectorAll('nav a').forEach(function(a) {
    a.addEventListener('click', function() {
      document.querySelector('nav').classList.remove('open');
    });
  });
  // FAQ toggles
  document.querySelectorAll('.faq-q').forEach(function(q) {
    q.addEventListener('click', function() {
      this.parentElement.classList.toggle('open');
    });
  });
  // Fade-in on scroll
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.fade-in').forEach(function(el) {
    observer.observe(el);
  });
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
};
