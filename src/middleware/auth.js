/**
 * Simple API key middleware.
 * The frontend sends: Authorization: Bearer <API_KEY>
 * The API_KEY lives in Railway env vars — never exposed to the browser.
 */
function verifyApiKey(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token || token !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { verifyApiKey };
