const { log } = require('./_log');

const cors = {
  "Access-Control-Allow-Origin": "*", // TODO: Lock to chrome-extension://EXTENSION_ID after CWS publish
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method !== "GET") {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: "Method not allowed" });
  }

  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  log('info', 'status_check', { endpoint: 'status' });

  return res.status(200).json({
    enabled: process.env.KILL_SWITCH_ENABLED !== 'false',
    minVersion: process.env.MIN_VERSION || "1.0.0",
    message: process.env.STATUS_MESSAGE || null,
    maintenance: process.env.MAINTENANCE_MODE === 'true'
  });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '50kb' } } };
