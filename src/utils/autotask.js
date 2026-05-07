const axios = require('axios');

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'UserName': process.env.AUTOTASK_USERNAME,
    'Secret': process.env.AUTOTASK_SECRET,
    'ApiIntegrationCode': process.env.AUTOTASK_INTEGRATION_CODE
  };
}

const BASE_URL = () => `${process.env.AUTOTASK_ZONE_URL}/v1.0`;

const autotaskClient = {
  post: (path, data) => {
    return axios({
      method: 'post',
      url: `${BASE_URL()}${path}`,
      data,
      transformRequest: [(data, headers) => {
        headers['UserName'] = process.env.AUTOTASK_USERNAME;
        headers['Secret'] = process.env.AUTOTASK_SECRET;
        headers['ApiIntegrationCode'] = process.env.AUTOTASK_INTEGRATION_CODE;
        headers['Content-Type'] = 'application/json';
        return JSON.stringify(data);
      }]
    });
  },
  get: (path) => axios({
    method: 'get',
    url: `${BASE_URL()}${path}`,
    headers: getHeaders()
  })
};

// Temporary debug interceptor - remove once working
axios.interceptors.request.use(request => {
  if (request.url && request.url.includes('autotask')) {
    console.log('[AutoTask Request URL]', request.url);
    console.log('[AutoTask Headers]', JSON.stringify({
      UserName: request.headers['UserName'],
      SecretLength: request.headers['Secret']?.length,
      ApiIntegrationCode: request.headers['ApiIntegrationCode']
    }));
  }
  return request;
});

module.exports = { autotaskClient };