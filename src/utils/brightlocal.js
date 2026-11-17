const axios = require('axios');

// BrightLocal API client, mirroring ghl.js's structure. Key-only auth
// (no secret) via the x-api-key header. Exact endpoint paths are NOT yet
// confirmed for this account; explore with /api/diagnostic/seo/brightlocal
// before building anything on top of this.

const BASE_URL = 'https://api.brightlocal.com';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-api-key': process.env.BRIGHTLOCAL_API_KEY
  };
}

const brightlocalClient = {
  get: (path, params) => axios.get(`${BASE_URL}${path}`, { headers: getHeaders(), params, timeout: 30000 }),
  post: (path, data, params) => axios.post(`${BASE_URL}${path}`, data, { headers: getHeaders(), params, timeout: 30000 })
};

module.exports = { brightlocalClient, getHeaders, BASE_URL };