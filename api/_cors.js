const CORS = {
  "Access-Control-Allow-Origin": process.env.EXTENSION_ID ? `chrome-extension://${process.env.EXTENSION_ID}` : "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-extension-token",
};
module.exports = CORS;
