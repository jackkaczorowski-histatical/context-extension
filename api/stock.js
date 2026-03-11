const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { ticker } = req.body || {};

  if (!ticker) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing ticker field" });
  }

  try {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker.toUpperCase())}?apiKey=${process.env.POLYGON_API_KEY}`;

    const response = await fetch(url);

    if (!response.ok) {
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(404).json({ error: "not found" });
    }

    const data = await response.json();
    const snap = data.ticker;

    if (!snap) {
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(404).json({ error: "not found" });
    }

    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json({
      ticker: snap.ticker,
      name: snap.name || snap.ticker,
      price: snap.day?.c ?? snap.lastTrade?.p ?? null,
      change: snap.todaysChange ?? null,
      changePercent: snap.todaysChangePerc ?? null,
      marketCap: snap.marketCap ?? null,
    });
  } catch (err) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};
