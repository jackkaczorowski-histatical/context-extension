const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function formatLargeNumber(num) {
  if (num == null) return null;
  if (num >= 1e12) return `$${(num / 1e12).toFixed(1)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
  return `$${num}`;
}

function formatVolume(num) {
  if (num == null) return null;
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return `${num}`;
}

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };

async function fetchChart1Y(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y&includePrePost=false`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return meta;
}

async function fetchChart1D(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d&includePrePost=false`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return meta;
}

async function resolveTickerFromName(name) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=1&newsCount=0`;
    const response = await fetch(url, { headers: UA });
    if (!response.ok) return null;
    const data = await response.json();
    const quote = data?.quotes?.[0];
    if (quote && quote.symbol && quote.quoteType === 'EQUITY') {
      return quote.symbol;
    }
    return null;
  } catch {
    return null;
  }
}

const { rateLimit } = require('./_rateLimit');

module.exports = async function handler(req, res) {
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientId = req.body?.installId || req.headers['x-forwarded-for'] || 'unknown';
  if (!rateLimit(clientId, 30, 60000)) {
    return res.status(429).json({ error: 'Rate limited', retry: true });
  }

  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  const symbol = ticker.toUpperCase();

  let meta1Y = null;
  let meta1D = null;
  try {
    [meta1Y, meta1D] = await Promise.all([
      fetchChart1Y(symbol).catch(() => null),
      fetchChart1D(symbol).catch(() => null),
    ]);
  } catch (err) {
    console.error('[STOCK API] parallel fetch failed for', symbol, ':', err.message);
  }

  let meta = meta1D || meta1Y;
  let resolvedSymbol = symbol;

  // If direct lookup failed, try resolving as a company name
  if (!meta) {
    const resolved = await resolveTickerFromName(ticker);
    if (resolved) {
      console.log('[STOCK API] Resolved name', ticker, '→', resolved);
      resolvedSymbol = resolved;
      try {
        [meta1Y, meta1D] = await Promise.all([
          fetchChart1Y(resolved).catch(() => null),
          fetchChart1D(resolved).catch(() => null),
        ]);
        meta = meta1D || meta1Y;
      } catch (err) {
        console.error('[STOCK API] retry fetch failed for', resolved, ':', err.message);
      }
    }
  }
  if (!meta) {
    return res.status(404).json({ error: "not found" });
  }

  const price = meta.regularMarketPrice;

  const dailyPrevClose = meta1D?.chartPreviousClose;
  let change = null;
  let changePercent = null;
  if (price != null && dailyPrevClose != null && dailyPrevClose !== 0) {
    change = Math.round((price - dailyPrevClose) * 100) / 100;
    changePercent = Math.round(((price - dailyPrevClose) / dailyPrevClose) * 100 * 100) / 100;
  }

  const fiftyTwoWeekLow = meta1Y?.fiftyTwoWeekLow != null ? Math.round(meta1Y.fiftyTwoWeekLow * 100) / 100 : null;
  const fiftyTwoWeekHigh = meta1Y?.fiftyTwoWeekHigh != null ? Math.round(meta1Y.fiftyTwoWeekHigh * 100) / 100 : null;

  const marketCapRaw = meta1Y?.marketCap ?? meta1D?.marketCap ?? null;
  const volumeRaw = meta.regularMarketVolume ?? null;

  let result = {
    ticker: meta.symbol || resolvedSymbol,
    name: meta.shortName || meta.symbol || resolvedSymbol,
    price: price ?? null,
    change,
    changePercent,
    marketCap: formatLargeNumber(marketCapRaw),
    fiftyTwoWeekLow,
    fiftyTwoWeekHigh,
    volume: formatVolume(volumeRaw),
    peRatio: null,
    dividendYield: null,
    sector: null,
    ytdReturn: null,
  };

  console.log('[STOCK API] Final result for', symbol, ':', JSON.stringify(result));
  return res.status(200).json(result);
};
