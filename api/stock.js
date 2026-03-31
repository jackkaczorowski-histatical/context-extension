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

// 1y range: gets 52-week high/low, marketCap, price, volume
async function fetchChart1Y(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y&includePrePost=false`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  console.log('[STOCK API] chart 1y raw response:', JSON.stringify(data).substring(0, 500));
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  console.log('[STOCK API] chart 1y meta keys:', Object.keys(meta));
  return meta;
}

// 1d range: gets accurate daily previousClose for change calculation
async function fetchChart1D(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d&includePrePost=false`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  console.log('[STOCK API] chart 1d raw response:', JSON.stringify(data).substring(0, 500));
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  console.log('[STOCK API] chart 1d meta keys:', Object.keys(meta));
  console.log('[STOCK API] chart 1d chartPreviousClose:', meta.chartPreviousClose, 'regularMarketPrice:', meta.regularMarketPrice);
  return meta;
}

async function fetchQuoteData(ticker) {
  const url = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${ticker}`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  console.log('[STOCK API] v6 quote raw response:', JSON.stringify(data).substring(0, 500));
  const quote = data?.quoteResponse?.result?.[0];
  if (!quote) return null;
  console.log('[STOCK API] v6 quote keys:', Object.keys(quote));

  return {
    peRatio: quote.trailingPE != null ? Math.round(quote.trailingPE * 10) / 10 : null,
    dividendYield: quote.dividendYield != null ? Math.round(quote.dividendYield * 100) / 100 : null,
    marketCap: quote.marketCap != null ? formatLargeNumber(quote.marketCap) : null,
    sector: quote.sector || null,
  };
}

module.exports = async function handler(req, res) {
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  const symbol = ticker.toUpperCase();

  // Fetch 1y chart (52-week data) and 1d chart (daily change) in parallel
  let meta1Y = null;
  let meta1D = null;
  try {
    [meta1Y, meta1D] = await Promise.all([
      fetchChart1Y(symbol).catch(err => { console.error('[STOCK API] chart 1y failed:', err.message); return null; }),
      fetchChart1D(symbol).catch(err => { console.error('[STOCK API] chart 1d failed:', err.message); return null; }),
    ]);
  } catch (err) {
    console.error('[STOCK API] parallel fetch failed for', symbol, ':', err.message);
  }

  // Need at least one chart response
  const meta = meta1D || meta1Y;
  if (!meta) {
    return res.status(404).json({ error: "not found" });
  }

  // Price from whichever responded (prefer 1d for freshness)
  const price = meta.regularMarketPrice;

  // Daily change from 1d endpoint (accurate daily previous close)
  const dailyPrevClose = meta1D?.chartPreviousClose;
  let change = null;
  let changePercent = null;
  if (price != null && dailyPrevClose != null && dailyPrevClose !== 0) {
    change = Math.round((price - dailyPrevClose) * 100) / 100;
    changePercent = Math.round(((price - dailyPrevClose) / dailyPrevClose) * 100 * 100) / 100;
  }
  console.log('[STOCK API] Daily change calc: price=', price, 'dailyPrevClose=', dailyPrevClose, 'change=', change, 'changePercent=', changePercent);

  // 52-week data from 1y endpoint
  const fiftyTwoWeekLow = meta1Y?.fiftyTwoWeekLow != null ? Math.round(meta1Y.fiftyTwoWeekLow * 100) / 100 : null;
  const fiftyTwoWeekHigh = meta1Y?.fiftyTwoWeekHigh != null ? Math.round(meta1Y.fiftyTwoWeekHigh * 100) / 100 : null;

  // MarketCap and volume from whichever has it
  const marketCapRaw = meta1Y?.marketCap ?? meta1D?.marketCap ?? null;
  const volumeRaw = meta.regularMarketVolume ?? null;

  let result = {
    ticker: meta.symbol || symbol,
    name: meta.shortName || meta.symbol || symbol,
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

  // Secondary: v6 quote endpoint for P/E and dividend (best-effort)
  try {
    const quoteData = await fetchQuoteData(symbol);
    console.log('[STOCK API] v6 quote data for', symbol, ':', JSON.stringify(quoteData));
    if (quoteData) {
      if (quoteData.peRatio != null) result.peRatio = quoteData.peRatio;
      if (quoteData.dividendYield != null) result.dividendYield = quoteData.dividendYield;
      if (quoteData.marketCap != null) result.marketCap = quoteData.marketCap;
      if (quoteData.sector != null) result.sector = quoteData.sector;
    }
  } catch (quoteErr) {
    console.error('[STOCK API] v6 quote failed for', symbol, '(non-fatal):', quoteErr.message || quoteErr);
  }

  console.log('[STOCK API] Final result for', symbol, ':', JSON.stringify(result));
  return res.status(200).json(result);
};
