const { rateLimit } = require('./_rateLimit');

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

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(`session-data_${ip}`, 10, 60000)) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  const { installId, userId, videoTitle, videoUrl, transcript, durationSeconds, entities, entityCount } = req.body || {};

  console.log('[SESSION-DATA]', { installId, userId, videoTitle, entityCount, durationSeconds });

  try {
    // Insert session transcript
    const transcriptRes = await fetch(`${SUPABASE_URL}/rest/v1/session_transcripts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      },
      body: JSON.stringify({
        install_id: installId || null,
        user_id: userId || null,
        video_title: videoTitle || null,
        video_url: videoUrl || null,
        transcript: transcript || null,
        duration_seconds: durationSeconds || null,
        entity_count: entityCount || 0
      })
    });

    if (!transcriptRes.ok) {
      const errText = await transcriptRes.text();
      console.error('[SESSION-DATA] Transcript insert failed:', transcriptRes.status, errText);
    }

    // Batch insert entities
    if (Array.isArray(entities) && entities.length > 0) {
      const entityRows = entities.map(e => ({
        install_id: installId || null,
        user_id: userId || null,
        term: e.term,
        type: e.type || null,
        description: e.description || null,
        video_title: videoTitle || null,
        video_url: videoUrl || null
      }));

      const entitiesRes = await fetch(`${SUPABASE_URL}/rest/v1/session_entities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY
        },
        body: JSON.stringify(entityRows)
      });

      if (!entitiesRes.ok) {
        const errText = await entitiesRes.text();
        console.error('[SESSION-DATA] Entities insert failed:', entitiesRes.status, errText);
      }
    }

    return res.status(200).json({ saved: true });
  } catch (err) {
    console.error('[SESSION-DATA] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
