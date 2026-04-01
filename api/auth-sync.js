const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "POST") { return res.status(405).json({ error: "Method not allowed" }); }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  const { googleId, email, name, installId, picture } = req.body || {};

  console.log('[AUTH SYNC]', { googleId, email, name, installId });

  // TODO: Upsert to Supabase
  // For now return placeholder
  return res.status(200).json({
    userId: googleId || installId,
    plan: 'free',
    minutesUsed: 0,
    minutesLimit: 30
  });
};
