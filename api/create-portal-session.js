const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};
const validateRequest = require('./_validateRequest');
const { log } = require('./_log');
const { captureError } = require('./_sentry');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST") { return res.status(405).json({ error: "Method not allowed" }); }
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  if (!validateRequest(req, res)) return;

  const { googleId } = req.body || {};
  if (!googleId) return res.status(400).json({ error: 'Missing googleId' });

  try {
    // Look up stripe_customer_id from Supabase
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${googleId}&select=stripe_customer_id`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
    });
    const users = await userRes.json();
    const customerId = users[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://context-extension-zv8d.vercel.app/api/portal-return',
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    captureError(err, { endpoint: 'create-portal-session' });
    return res.status(500).json({ error: err.message });
  }
};
module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
