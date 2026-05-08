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
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 429) {
      console.log('[429 Response Body]', JSON.stringify(error.response.data));
    }
    if (error.response?.status === 500) {
      console.log('[500 Response Body]', JSON.stringify(error.response.data));
      console.log('[500 Request URL]', error.config?.url);
      console.log('[500 Request Method]', error.config?.method);
      console.log('[500 Request Body]', error.config?.data);
    }
    return Promise.reject(error);
  }
);

axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 429) {
      console.log('[429 Response Body]', JSON.stringify(error.response.data));
    }
    return Promise.reject(error);
  }
);

module.exports = { autotaskClient, getHeaders };