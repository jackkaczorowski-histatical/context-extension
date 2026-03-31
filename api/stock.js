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

async function fetchQuoteSummary(ticker) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=price,summaryDetail,defaultKeyStatistics`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  const result = data?.quoteSummary?.result?.[0];
  if (!result) return null;

  const price = result.price || {};
  const summary = result.summaryDetail || {};

  const divYieldRaw = summary.dividendYield?.raw;

  return {
    ticker: price.symbol || ticker,
    name: price.shortName || price.longName || ticker,
    price: price.regularMarketPrice?.raw ?? null,
    change: price.regularMarketChange?.raw != null ? Math.round(price.regularMarketChange.raw * 100) / 100 : null,
    changePercent: price.regularMarketChangePercent?.raw != null ? Math.round(price.regularMarketChangePercent.raw * 100) / 100 : null,
    marketCap: formatLargeNumber(price.marketCap?.raw),
    peRatio: summary.trailingPE?.raw != null ? Math.round(summary.trailingPE.raw * 10) / 10 : null,
    dividendYield: divYieldRaw != null ? Math.round(divYieldRaw * 100 * 100) / 100 : null,
    fiftyTwoWeekLow: summary.fiftyTwoWeekLow?.raw != null ? Math.round(summary.fiftyTwoWeekLow.raw * 100) / 100 : null,
    fiftyTwoWeekHigh: summary.fiftyTwoWeekHigh?.raw != null ? Math.round(summary.fiftyTwoWeekHigh.raw * 100) / 100 : null,
    volume: formatVolume(price.regularMarketVolume?.raw),
    sector: null,
    ytdReturn: null,
  };
}

async function fetchChartFallback(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;

  return {
    ticker: meta.symbol,
    name: meta.shortName || meta.symbol,
    price: meta.regularMarketPrice,
    change: Math.round((meta.regularMarketPrice - meta.chartPreviousClose) * 100) / 100,
    changePercent: Math.round(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 * 100) / 100,
    marketCap: formatLargeNumber(meta.marketCap),
    peRatio: null,
    dividendYield: null,
    fiftyTwoWeekLow: null,
    fiftyTwoWeekHigh: null,
    volume: null,
    sector: null,
    ytdReturn: null,
  };
}

module.exports = async function handler(req, res) {
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  const symbol = ticker.toUpperCase();

  try {
    const result = await fetchQuoteSummary(symbol);
    console.log('[STOCK API] quoteSummary for', symbol, ':', JSON.stringify(result));
    if (result) return res.status(200).json(result);
  } catch (summaryErr) {
    console.error('[STOCK API] quoteSummary failed for', symbol, ':', summaryErr.message || summaryErr);
    // fall through to chart fallback
  }

  try {
    console.log('[STOCK API] Falling back to chart endpoint for', symbol);
    const result = await fetchChartFallback(symbol);
    console.log('[STOCK API] chart fallback for', symbol, ':', JSON.stringify(result));
    if (result) return res.status(200).json(result);
    return res.status(404).json({ error: "not found" });
  } catch (err) {
    console.error('[STOCK API] chart fallback also failed for', symbol, ':', err.message);
    return res.status(500).json({ error: err.message });
  }
};
