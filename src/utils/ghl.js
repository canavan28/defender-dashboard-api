const axios = require('axios');

const BASE_URL = 'https://services.leadconnectorhq.com';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
    'Version': '2021-07-28'
  };
}

const ghlClient = {
  get: (path, params) => axios.get(`${BASE_URL}${path}`, { headers: getHeaders(), params }),
  post: (path, data, params) => axios.post(`${BASE_URL}${path}`, data, { headers: getHeaders(), params })
};

module.exports = { ghlClient, getHeaders, BASE_URL };