const rateLimits = new Map();

function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const record = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  rateLimits.set(key, record);

  // Clean old entries periodically
  if (rateLimits.size > 10000) {
    for (const [k, v] of rateLimits) {
      if (now > v.resetAt) rateLimits.delete(k);
    }
  }

  return record.count <= maxRequests;
}

module.exports = { rateLimit };
