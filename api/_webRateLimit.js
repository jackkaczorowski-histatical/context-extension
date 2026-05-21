const { Redis } = require('@upstash/redis');
const { log } = require('./_log');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Generous during testing. Tighten to 5 before public launch.
const MAX_REQUESTS = 30; // TODO: tighten to 5 before launch
const WINDOW_MS = 3600000; // 1 hour

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.connection?.remoteAddress || 'unknown';
}

async function webRateLimit(req) {
  const ip = getClientIp(req);
  const key = `web_rl:${ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, WINDOW_MS);
    }
    const ttl = await redis.pttl(key);
    const resetAt = Date.now() + Math.max(ttl, 0);
    return {
      allowed: count <= MAX_REQUESTS,
      remaining: Math.max(MAX_REQUESTS - count, 0),
      resetAt,
    };
  } catch (err) {
    log('error', 'web_rate_limit_redis_error', { error: err.message });
    return { allowed: true, remaining: MAX_REQUESTS, resetAt: Date.now() + WINDOW_MS };
  }
}

module.exports = webRateLimit;
