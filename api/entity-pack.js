const { rateLimit } = require('./_rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function normalizeKey(term) {
  return (term || '').toLowerCase().trim().replace(/s$/, '');
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

  // GET — retrieve pack for a video
  if (req.method === "GET") {
    if (!rateLimit(`epack-get_${ip}`, 30, 60000)) {
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
        console.error('[ENTITY-PACK] GET failed:', supaRes.status, errText);
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
      console.error('[ENTITY-PACK] GET error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // POST — upsert entities for a video
  if (req.method === "POST") {
    if (!rateLimit(`epack-post_${ip}`, 10, 60000)) {
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
        if (!existing || (e.description || '').length > (existing.description || '').length) {
          entityMap.set(key, { term: e.term, type: e.type, description: e.description || '', ticker: e.ticker || null, salience: e.salience || 'highlight', followUps: e.followUps || [] });
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
          console.error('[ENTITY-PACK] PATCH failed:', updateRes.status, errText);
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
          console.error('[ENTITY-PACK] INSERT failed:', insertRes.status, errText);
          return res.status(500).json({ error: 'Insert failed' });
        }
      }

      console.log('[ENTITY-PACK]', isUpdate ? 'Updated' : 'Created', 'pack for', videoId, '- entities:', mergedEntities.length, 'insights:', mergedInsights.length);
      return res.status(200).json({ saved: true, entityCount: mergedEntities.length, insightCount: mergedInsights.length });
    } catch (err) {
      console.error('[ENTITY-PACK] POST error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
