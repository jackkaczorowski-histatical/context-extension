const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST") { return res.status(405).json({ error: "Method not allowed" }); }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  const { googleId, email, name, installId, picture } = req.body || {};

  console.log('[AUTH SYNC]', { googleId, email, name, installId });

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
      console.error('[AUTH SYNC] Supabase upsert failed:', upsertRes.status, errText);
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
    console.error('[AUTH SYNC] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
