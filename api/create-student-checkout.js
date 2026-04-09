const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

  const { googleId, email, studentEmail } = req.body || {};
  if (!googleId || !email) return res.status(400).json({ error: 'Missing googleId or email' });
  if (!studentEmail || !studentEmail.endsWith('.edu')) {
    return res.status(400).json({ error: 'A valid .edu email is required for the student discount' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: process.env.STRIPE_PRICE_MONTHLY, quantity: 1 }],
      discounts: [{ coupon: 'STUDENT50' }],
      success_url: 'https://context-extension-zv8d.vercel.app/api/checkout-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://context-extension-zv8d.vercel.app/api/checkout-cancel',
      metadata: { googleId, studentEmail },
      subscription_data: { metadata: { googleId, studentEmail } },
    });

    log('info', 'student_checkout_created', { endpoint: 'create-student-checkout', studentEmail });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    captureError(err, { endpoint: 'create-student-checkout' });
    return res.status(500).json({ error: err.message });
  }
};
module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
