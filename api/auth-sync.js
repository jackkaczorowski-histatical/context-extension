const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  "Access-Control-Allow-Origin": "*",
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

  const { googleId, email, name, installId, picture } = req.body || {};

  log('info', 'auth_sync_request', { endpoint: 'auth-sync', hasGoogleId: !!googleId });

  if (!googleId) {
    return res.status(400).json({ error: 'Missing googleId' });
  }

  try {
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({
        id: googleId,
        email,
        name,
        picture,
        install_id: installId,
        last_seen: new Date().toISOString()
      })
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      log('error', 'auth_sync_upsert_failed', { endpoint: 'auth-sync', status: upsertRes.status });
      return res.status(500).json({ error: 'Database error' });
    }

    const rows = await upsertRes.json();
    const user = rows[0] || {};

    return res.status(200).json({
      userId: user.id || googleId,
      plan: user.plan || 'free',
      minutesUsed: user.minutes_used || 0,
      minutesLimit: user.minutes_limit || 30
    });
  } catch (err) {
    captureError(err, { endpoint: 'auth-sync' });
    log('error', 'auth_sync_error', { endpoint: 'auth-sync', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
