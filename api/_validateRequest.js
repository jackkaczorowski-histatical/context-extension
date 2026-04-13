// TODO: After CWS publish, set EXTENSION_ID env var in Vercel and uncomment CORS lock in each API file
module.exports = function validateRequest(req, res) {
  const token = req.headers['x-extension-token'];
  if (token !== process.env.EXTENSION_API_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  // Validate installId format if present
  const installId = req.body?.installId || req.query?.installId;
  if (installId && !/^ctx_[a-z0-9]+_[a-z0-9]+$/.test(installId)) {
    res.status(400).json({ error: 'Invalid installId format' });
    return false;
  }

  return true;
};
