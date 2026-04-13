const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { log } = require('./_log');
const { captureError } = require('./_sentry');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function updateUserSubscription(googleId, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${googleId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(updates)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Supabase update failed: ${res.status} ${errText}`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    log('error', 'stripe_webhook_sig_failed', { error: err.message });
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  log('info', 'stripe_webhook_received', { type: event.type });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const googleId = session.metadata?.googleId;
        if (!googleId) break;
        const subscriptionId = session.subscription;
        const customerId = session.customer;

        // Get subscription details to find plan type
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = sub.items.data[0]?.price?.id;
        const isAnnual = priceId === process.env.STRIPE_PRICE_ANNUAL;

        await updateUserSubscription(googleId, {
          plan: 'pro',
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          subscription_status: 'active',
          plan_type: isAnnual ? 'annual' : 'monthly',
          plan_expires_at: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          minutes_limit: 999999
        });
        log('info', 'stripe_checkout_completed', { googleId, plan: isAnnual ? 'annual' : 'monthly' });
        try {
          const customerEmail = session.customer_details?.email || session.customer_email;
          if (customerEmail) {
            await resend.emails.send({
              from: 'Context <noreply@contextlistener.com>',
              to: customerEmail,
              subject: 'Welcome to Context Pro!',
              html: '<h2>Welcome to Context Pro! \ud83c\udf89</h2><p>Your subscription is active. You now have unlimited listening time, full session history, knowledge base exports, and follow-up questions.</p><p>Open any YouTube video, click the Context icon, and start listening \u2014 no daily limit.</p><p>Need help? Reply to this email or visit <a href="https://contextlistener.com/faq">our FAQ</a>.</p><p>\u2014 Jack, Context founder</p>'
            });
            log('info', 'welcome_email_sent', { email: customerEmail });
          }
        } catch (emailErr) {
          log('warn', 'welcome_email_failed', { error: emailErr.message });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const googleId = sub.metadata?.googleId;
        if (!googleId) break;
        const status = sub.status; // active, past_due, canceled, etc.
        const plan = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
        await updateUserSubscription(googleId, {
          plan,
          subscription_status: status,
          plan_expires_at: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          minutes_limit: plan === 'pro' ? 999999 : 30
        });
        log('info', 'stripe_subscription_updated', { googleId, status, plan });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const googleId = sub.metadata?.googleId;
        if (!googleId) break;
        await updateUserSubscription(googleId, {
          plan: 'free',
          subscription_status: 'canceled',
          minutes_limit: 30
        });
        log('info', 'stripe_subscription_deleted', { googleId });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const googleId = sub.metadata?.googleId;
          if (googleId) {
            await updateUserSubscription(googleId, {
              subscription_status: 'past_due'
            });
            log('warn', 'stripe_payment_failed', { googleId });
          }
        }
        break;
      }
    }
  } catch (err) {
    captureError(err, { endpoint: 'stripe-webhook', eventType: event.type });
    log('error', 'stripe_webhook_handler_error', { type: event.type, error: err.message });
  }

  return res.status(200).json({ received: true });
};

// CRITICAL: bodyParser must be false for Stripe signature verification
module.exports.config = { api: { bodyParser: false } };
