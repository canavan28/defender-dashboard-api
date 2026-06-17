const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const ALLOWED_IDS = (process.env.ALLOWED_USER_OBJECT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

// Dashboard-access "owner" flag — distinct from the VTO doc's free-text
// "Rocks owner" field. Controls who can see/edit the VTO tab.
const OWNER_IDS = (process.env.OWNER_OBJECT_IDS || '')
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
    audience: `api://${CLIENT_ID}`,
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

    req.user = {
      oid,
      name: decoded.name,
      email: decoded.preferred_username,
      isOwner: OWNER_IDS.includes(oid)
    };
    next();
  });
}

// Gate for owner-only routes (e.g. VTO). Mount AFTER verifyApiKey so
// req.user is already populated.
function requireOwner(req, res, next) {
  if (!req.user || !req.user.isOwner) {
    console.warn('[Auth] Non-owner attempted owner-only route:', req.user?.oid);
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

module.exports = { verifyApiKey, requireOwner };