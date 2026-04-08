const { Redis } = require('@upstash/redis');
const { log } = require('./_log');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DAILY_BUDGET_CENTS = 5000; // $50/day

function getBudgetKey() {
  const d = new Date().toISOString().slice(0, 10);
  return `budget:${d}`;
}

const COST_ESTIMATES = {
  analyze: 1,
  ask: 2,
  context: 1,
  deepgram_minute: 1,
};

async function checkBudget() {
  try {
    const key = getBudgetKey();
    const spent = parseInt(await redis.get(key) || '0', 10);
    return spent < DAILY_BUDGET_CENTS;
  } catch (err) {
    log('warn', 'budget_check_error', { error: err.message });
    return true;
  }
}

async function recordSpend(operation) {
  try {
    const key = getBudgetKey();
    const cost = COST_ESTIMATES[operation] || 1;
    const newTotal = await redis.incrby(key, cost);
    if (newTotal === cost) {
      await redis.expire(key, 90000);
    }
    if (newTotal >= DAILY_BUDGET_CENTS) {
      log('error', 'daily_budget_exceeded', { spent: newTotal, limit: DAILY_BUDGET_CENTS });
    }
    return newTotal < DAILY_BUDGET_CENTS;
  } catch (err) {
    log('warn', 'budget_record_error', { error: err.message });
    return true;
  }
}

module.exports = { checkBudget, recordSpend };
