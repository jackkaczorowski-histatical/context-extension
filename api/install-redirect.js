const { log } = require('./_log');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CWS_URL = 'https://chromewebstore.google.com/detail/context/PLACEHOLDER';

module.exports = async function handler(req, res) {
  const source = req.query.source || 'direct';

  const forwarded = req.headers['x-forwarded-for'] || '';
  const ip = forwarded.split(',')[0].trim();
  const octets = ip.split('.');
  const ipPrefix = octets.length >= 3 ? octets.slice(0, 3).join('.') : ip;

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/install_clicks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      },
      body: JSON.stringify({ source, ip_prefix: ipPrefix })
    });
  } catch (err) {
    log('error', 'install_click_insert_failed', { source, error: err.message });
  }

  res.writeHead(302, { Location: `${CWS_URL}?utm_source=${encodeURIComponent(source)}` });
  return res.end();
};
