const { Redis } = require('@upstash/redis');
const { log } = require('./_log');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function checkAnthropic() {
  const start = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    const latency = Date.now() - start;
    if (res.ok) return { status: "ok", latency_ms: latency, error: null };
    return { status: "degraded", latency_ms: latency, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "degraded", latency_ms: Date.now() - start, error: err.message };
  }
}

async function checkSupabase() {
  const start = Date.now();
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: process.env.SUPABASE_KEY },
    });
    const latency = Date.now() - start;
    if (res.ok) return { status: "ok", latency_ms: latency, error: null };
    return { status: "degraded", latency_ms: latency, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "degraded", latency_ms: Date.now() - start, error: err.message };
  }
}

async function checkDeepgram() {
  const start = Date.now();
  try {
    const res = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
    });
    const latency = Date.now() - start;
    if (res.ok) return { status: "ok", latency_ms: latency, error: null };
    return { status: "degraded", latency_ms: latency, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "degraded", latency_ms: Date.now() - start, error: err.message };
  }
}

async function checkRedis() {
  const start = Date.now();
  try {
    await redis.ping();
    return { status: "ok", latency_ms: Date.now() - start, error: null };
  } catch (err) {
    return { status: "degraded", latency_ms: Date.now() - start, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "GET") {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: "Method not allowed" });
  }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  const [anthropic, supabase, deepgram, redisCheck] = await Promise.all([
    checkAnthropic(),
    checkSupabase(),
    checkDeepgram(),
    checkRedis(),
  ]);

  const checks = { anthropic, supabase, deepgram, redis: redisCheck };
  const allOk = Object.values(checks).every(c => c.status === "ok");
  const status = allOk ? "healthy" : "degraded";

  log('info', 'health_check', { status, anthropic: anthropic.status, supabase: supabase.status, deepgram: deepgram.status, redis: redisCheck.status });

  return res.status(allOk ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    checks,
  });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
