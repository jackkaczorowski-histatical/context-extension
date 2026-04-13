const crypto = require('crypto');
const { Resend } = require('resend');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const resend = new Resend(process.env.RESEND_API_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*", // TODO: Lock to chrome-extension://EXTENSION_ID after CWS publish
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};
const validateRequest = require('./_validateRequest');
const { log } = require('./_log');
const { captureError } = require('./_sentry');

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST") { return res.status(405).json({ error: "Method not allowed" }); }
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (!validateRequest(req, res)) return;

  const { studentEmail, googleId, installId } = req.body || {};
  if (!googleId) return res.status(400).json({ error: 'Missing googleId' });
  if (!studentEmail || !studentEmail.endsWith('.edu')) {
    return res.status(400).json({ error: 'A valid .edu email is required' });
  }

  try {
    const token = crypto.randomBytes(32).toString('hex');

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/student_verifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        google_id: googleId,
        student_email: studentEmail,
        token,
        verified: false,
        created_at: new Date().toISOString()
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      log('error', 'student_verification_insert_failed', { endpoint: 'send-student-verification', status: insertRes.status });
      return res.status(500).json({ error: 'Failed to create verification record' });
    }

    await resend.emails.send({
      from: 'Context <noreply@contextlistener.com>',
      to: studentEmail,
      subject: 'Verify your student email for Context',
      html: '<h2>Verify your student email</h2><p>Click the link below to verify your .edu email and unlock 50% off Context Pro:</p><a href="https://contextlistener.com/verify-student?token=' + token + '">Verify my email</a><p>This link expires in 24 hours.</p>'
    });

    log('info', 'student_verification_sent', { endpoint: 'send-student-verification', studentEmail });
    return res.status(200).json({ sent: true });
  } catch (err) {
    captureError(err, { endpoint: 'send-student-verification' });
    return res.status(500).json({ error: err.message });
  }
};
module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
