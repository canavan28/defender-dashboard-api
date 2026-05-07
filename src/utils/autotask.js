const axios = require('axios');

const BASE_URL = () => `${process.env.AUTOTASK_ZONE_URL}/v1.0`;

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'UserName': process.env.AUTOTASK_USERNAME,
    'Secret': process.env.AUTOTASK_SECRET,
    'ApiIntegrationCode': process.env.AUTOTASK_INTEGRATION_CODE
  };
}

const autotaskClient = {
  post: (path, data) => axios.post(`${BASE_URL()}${path}`, data, { headers: getHeaders() }),
  get: (path) => axios.get(`${BASE_URL()}${path}`, { headers: getHeaders() })
};

// Temporary debug interceptor
axios.interceptors.request.use(request => {
  if (request.url && request.url.includes('autotask')) {
    console.log('[AutoTask Request URL]', request.url);
    console.log('[AutoTask Headers]', JSON.stringify({
      UserName: request.headers['UserName'] || request.headers['username'],
      SecretLength: (request.headers['Secret'] || request.headers['secret'])?.length,
      ApiIntegrationCode: request.headers['ApiIntegrationCode'] || request.headers['apiintegrationcode']
    }));
  }
  return request;
});
// Response interceptor to log 429 details
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 429) {
      console.log('[429 Response Body]', JSON.stringify(error.response.data));
      console.log('[429 Response Headers]', JSON.stringify(error.response.headers));
    }
    return Promise.reject(error);
  }
);
module.exports = { autotaskClient };