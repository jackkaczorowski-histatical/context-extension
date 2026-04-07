const { rateLimit } = require('./_rateLimit');
const validateRequest = require('./_validateRequest');
const { log } = require('./_log');
const { captureError } = require('./_sentry');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};

function normalizeKey(term) {
  return (term || '').toLowerCase().trim().replace(/s$/, '');
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (!validateRequest(req, res)) return;

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

  // GET — retrieve pack for a video
  if (req.method === "GET") {
    if (!await rateLimit(`epack-get_${ip}`, 30, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    const videoId = req.query?.videoId;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Invalid or missing videoId' });
    }

    try {
      const supaRes = await fetch(
        `${SUPABASE_URL}/rest/v1/entity_packs?video_id=eq.${videoId}&select=video_id,title,entities,insights,view_count`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY
          }
        }
      );

      if (!supaRes.ok) {
        const errText = await supaRes.text();
        log('error', 'entity_pack_get_failed', { endpoint: 'entity-pack', status: supaRes.status });
        return res.status(500).json({ error: 'Database error' });
      }

      const rows = await supaRes.json();
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: 'No pack found' });
      }

      const pack = rows[0];

      // Increment view_count (fire and forget)
      fetch(
        `${SUPABASE_URL}/rest/v1/entity_packs?video_id=eq.${videoId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY
          },
          body: JSON.stringify({ view_count: (pack.view_count || 0) + 1 })
        }
      ).catch(() => {});

      return res.status(200).json({
        videoId: pack.video_id,
        title: pack.title,
        entities: pack.entities || [],
        insights: pack.insights || [],
        viewCount: pack.view_count || 0
      });
    } catch (err) {
      captureError(err, { endpoint: 'entity-pack', method: 'GET' });
      log('error', 'entity_pack_get_error', { endpoint: 'entity-pack', error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // POST — upsert entities for a video
  if (req.method === "POST") {
    if (!await rateLimit(`epack-post_${ip}`, 10, 60000)) {
      return res.status(429).json({ error: 'Rate limited' });
    }

    const { videoId, title, entities, insights } = req.body || {};

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Invalid or missing videoId' });
    }
    if (!Array.isArray(entities) || entities.length === 0) {
      return res.status(400).json({ error: 'Missing or empty entities array' });
    }

    try {
      // Fetch existing pack
      const existRes = await fetch(
        `${SUPABASE_URL}/rest/v1/entity_packs?video_id=eq.${videoId}&select=entities,insights,view_count`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY
          }
        }
      );

      let existingEntities = [];
      let existingInsights = [];
      let existingViewCount = 0;
      let isUpdate = false;

      if (existRes.ok) {
        const rows = await existRes.json();
        if (rows && rows.length > 0) {
          existingEntities = rows[0].entities || [];
          existingInsights = rows[0].insights || [];
          existingViewCount = rows[0].view_count || 0;
          isUpdate = true;
        }
      }

      // Merge entities: deduplicate by normalized term, keep the one with the longer description
      const entityMap = new Map();
      existingEntities.forEach(e => {
        const key = normalizeKey(e.term);
        if (key) entityMap.set(key, e);
      });
      entities.forEach(e => {
        const key = normalizeKey(e.term);
        if (!key) return;
        const existing = entityMap.get(key);
        if (!existing) {
          entityMap.set(key, { term: e.term, type: e.type, description: e.description || '', ticker: e.ticker || null, salience: e.salience || 'highlight', followUps: e.followUps || [], thumbnail: e.thumbnail || null });
        } else {
          // Update description if new one is longer
          if ((e.description || '').length > (existing.description || '').length) {
            existing.description = e.description;
          }
          // Backfill followUps if existing has none
          if ((!existing.followUps || existing.followUps.length === 0) && e.followUps && e.followUps.length > 0) {
            existing.followUps = e.followUps;
          }
          // Backfill thumbnail if existing has none
          if (!existing.thumbnail && e.thumbnail) {
            existing.thumbnail = e.thumbnail;
          }
        }
      });
      const mergedEntities = Array.from(entityMap.values()).slice(0, 100);

      // Merge insights: deduplicate by normalized insight text
      const insightMap = new Map();
      existingInsights.forEach(i => {
        const key = (i.insight || '').toLowerCase().trim();
        if (key) insightMap.set(key, i);
      });
      (insights || []).forEach(i => {
        const key = (i.insight || '').toLowerCase().trim();
        if (!key) return;
        if (!insightMap.has(key)) {
          insightMap.set(key, { insight: i.insight, detail: i.detail || '', category: i.category || 'tip' });
        }
      });
      const mergedInsights = Array.from(insightMap.values()).slice(0, 50);

      const row = {
        video_id: videoId,
        title: title || null,
        entities: mergedEntities,
        insights: mergedInsights,
        view_count: existingViewCount + 1
      };

      if (isUpdate) {
        const updateRes = await fetch(
          `${SUPABASE_URL}/rest/v1/entity_packs?video_id=eq.${videoId}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + SUPABASE_KEY
            },
            body: JSON.stringify({
              entities: mergedEntities,
              insights: mergedInsights,
              title: title || null,
              view_count: existingViewCount + 1
            })
          }
        );
        if (!updateRes.ok) {
          const errText = await updateRes.text();
          log('error', 'entity_pack_patch_failed', { endpoint: 'entity-pack', status: updateRes.status });
          return res.status(500).json({ error: 'Update failed' });
        }
      } else {
        const insertRes = await fetch(
          `${SUPABASE_URL}/rest/v1/entity_packs`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + SUPABASE_KEY,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify(row)
          }
        );
        if (!insertRes.ok) {
          const errText = await insertRes.text();
          log('error', 'entity_pack_insert_failed', { endpoint: 'entity-pack', status: insertRes.status });
          return res.status(500).json({ error: 'Insert failed' });
        }
      }

      log('info', 'entity_pack_saved', { endpoint: 'entity-pack', action: isUpdate ? 'updated' : 'created', videoId, entityCount: mergedEntities.length, insightCount: mergedInsights.length });
      return res.status(200).json({ saved: true, entityCount: mergedEntities.length, insightCount: mergedInsights.length });
    } catch (err) {
      captureError(err, { endpoint: 'entity-pack', method: 'POST' });
      log('error', 'entity_pack_post_error', { endpoint: 'entity-pack', error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
