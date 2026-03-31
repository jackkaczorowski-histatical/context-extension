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

async function fetchChartData(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y&includePrePost=false`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  console.log('Stock API chart raw response:', JSON.stringify(data).substring(0, 500));
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose;

  return {
    ticker: meta.symbol || ticker,
    name: meta.shortName || meta.symbol || ticker,
    price: price ?? null,
    change: price != null && prevClose != null ? Math.round((price - prevClose) * 100) / 100 : null,
    changePercent: price != null && prevClose != null && prevClose !== 0 ? Math.round(((price - prevClose) / prevClose) * 100 * 100) / 100 : null,
    marketCap: formatLargeNumber(meta.marketCap),
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow != null ? Math.round(meta.fiftyTwoWeekLow * 100) / 100 : null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh != null ? Math.round(meta.fiftyTwoWeekHigh * 100) / 100 : null,
    volume: formatVolume(meta.regularMarketVolume),
    peRatio: null,
    dividendYield: null,
    sector: null,
    ytdReturn: null,
  };
}

async function fetchQuoteData(ticker) {
  const url = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${ticker}`;
  const response = await fetch(url, { headers: UA });
  const data = await response.json();
  console.log('Stock API v6 quote raw response:', JSON.stringify(data).substring(0, 500));
  const quote = data?.quoteResponse?.result?.[0];
  if (!quote) return null;

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

  // Primary: v8 chart endpoint with 1y range for 52-week data
  let chartResult = null;
  try {
    chartResult = await fetchChartData(symbol);
    console.log('[STOCK API] chart data for', symbol, ':', JSON.stringify(chartResult));
  } catch (chartErr) {
    console.error('[STOCK API] chart endpoint failed for', symbol, ':', chartErr.message || chartErr);
  }

  if (!chartResult) {
    return res.status(404).json({ error: "not found" });
  }

  // Secondary: v6 quote endpoint for P/E and dividend (best-effort)
  try {
    const quoteData = await fetchQuoteData(symbol);
    console.log('[STOCK API] v6 quote data for', symbol, ':', JSON.stringify(quoteData));
    if (quoteData) {
      if (quoteData.peRatio != null) chartResult.peRatio = quoteData.peRatio;
      if (quoteData.dividendYield != null) chartResult.dividendYield = quoteData.dividendYield;
      if (quoteData.marketCap != null) chartResult.marketCap = quoteData.marketCap;
      if (quoteData.sector != null) chartResult.sector = quoteData.sector;
    }
  } catch (quoteErr) {
    console.error('[STOCK API] v6 quote failed for', symbol, '(non-fatal):', quoteErr.message || quoteErr);
  }

  console.log('[STOCK API] Final result for', symbol, ':', JSON.stringify(chartResult));
  return res.status(200).json(chartResult);
};
