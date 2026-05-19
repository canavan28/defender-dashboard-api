const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const ALLOWED_IDS = (process.env.ALLOWED_USER_OBJECT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000 // 10 minutes
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyApiKey(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, getKey, {
    audience: CLIENT_ID,
    issuer: [
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      `https://sts.windows.net/${TENANT_ID}/`
    ],
    algorithms: ['RS256']
  }, (err, decoded) => {
    if (err) {
      console.error('[Auth] Token verification failed:', err.message);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Check object ID against allowlist
    const oid = decoded.oid || decoded.sub;
    if (!ALLOWED_IDS.includes(oid)) {
      console.warn('[Auth] Unauthorized user attempted access:', oid);
      return res.status(403).json({ error: 'Access denied' });
    }

    req.user = { oid, name: decoded.name, email: decoded.preferred_username };
    next();
  });
}

module.exports = { verifyApiKey };