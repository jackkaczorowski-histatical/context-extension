const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const { log } = require('./_log');
const { captureError } = require('./_sentry');

function htmlPage(title, message, success) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Context</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0f1a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#151b2e;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:48px 40px;max-width:440px;text-align:center}
h1{font-size:24px;margin-bottom:12px;color:${success ? '#14b8a6' : '#ef4444'}}
p{font-size:14px;color:#94a3b8;line-height:1.6}
.icon{font-size:48px;margin-bottom:16px}
</style></head><body>
<div class="card">
<div class="icon">${success ? '\u2705' : '\u274c'}</div>
<h1>${title}</h1>
<p>${message}</p>
</div></body></html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") { return res.status(405).json({ error: "Method not allowed" }); }

  const token = req.query.token;
  if (!token) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).end(htmlPage('Invalid Link', 'This verification link is invalid or expired.', false));
  }

  try {
    // Look up token
    const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/student_verifications?token=eq.${encodeURIComponent(token)}&select=*`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      }
    });

    if (!lookupRes.ok) {
      log('error', 'student_verify_lookup_failed', { endpoint: 'verify-student', status: lookupRes.status });
      res.setHeader('Content-Type', 'text/html');
      return res.status(500).end(htmlPage('Error', 'Something went wrong. Please try again.', false));
    }

    const rows = await lookupRes.json();
    if (!rows || rows.length === 0) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).end(htmlPage('Invalid Link', 'This verification link is invalid or expired.', false));
    }

    const record = rows[0];

    // Check expiry (24 hours)
    const createdAt = new Date(record.created_at);
    const now = new Date();
    if (now - createdAt > 24 * 60 * 60 * 1000) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(410).end(htmlPage('Link Expired', 'This verification link has expired. Please request a new one from the Context extension.', false));
    }

    // Mark as verified
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/student_verifications?token=eq.${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ verified: true })
    });

    if (!updateRes.ok) {
      log('error', 'student_verify_update_failed', { endpoint: 'verify-student', status: updateRes.status });
      res.setHeader('Content-Type', 'text/html');
      return res.status(500).end(htmlPage('Error', 'Something went wrong. Please try again.', false));
    }

    log('info', 'student_email_verified', { endpoint: 'verify-student', studentEmail: record.student_email });
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).end(htmlPage(
      'Email Verified!',
      'Your student email is verified! Return to Context and click the student discount button to get 50% off.',
      true
    ));
  } catch (err) {
    captureError(err, { endpoint: 'verify-student' });
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).end(htmlPage('Error', 'Something went wrong. Please try again.', false));
  }
};
