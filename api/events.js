const { rateLimit } = require('./_rateLimit');
const validateRequest = require('./_validateRequest');
const { log } = require('./_log');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST") { return res.status(405).json({ error: "Method not allowed" }); }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (!validateRequest(req, res)) return;

  const clientId = req.body?.installId || req.headers['x-forwarded-for'] || 'unknown';
  if (!await rateLimit(clientId, 30, 60000)) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  const { events } = req.body || {};

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'No events provided' });
  }

  log('info', 'events_received', { endpoint: 'events', count: events.length, eventTypes: events.map(e => e.event) });

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      },
      body: JSON.stringify(events.map(e => ({
        install_id: e.installId,
        user_id: e.userId,
        event: e.event,
        properties: e.properties || {},
        session_id: e.sessionId || null,
        url: e.url || null
      })))
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      log('error', 'events_insert_failed', { endpoint: 'events', status: insertRes.status });
      return res.status(500).json({ error: 'Database error' });
    }

    return res.status(200).json({ received: events.length });
  } catch (err) {
    log('error', 'events_error', { endpoint: 'events', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
