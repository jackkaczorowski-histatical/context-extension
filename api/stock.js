const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { ticker } = req.body || {};
  if (!ticker) return res.status(400).json({ error: "Missing ticker" });

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const data = await response.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return res.status(404).json({ error: "not found" });

    return res.status(200).json({
      ticker: meta.symbol,
      name: meta.shortName || meta.symbol,
      price: meta.regularMarketPrice,
      change: (meta.regularMarketPrice - meta.chartPreviousClose).toFixed(2),
      changePercent: (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2),
      marketCap: meta.marketCap
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
