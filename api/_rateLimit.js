const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function rateLimit(key, maxRequests, windowMs) {
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, windowMs);
    }
    return count <= maxRequests;
  } catch (err) {
    console.error('[RATE-LIMIT] Redis error, failing open:', err.message);
    return true;
  }
}

module.exports = { rateLimit };
