const axios = require('axios');

// Shared AutoTask API client.
// All routes import this instead of creating their own axios instance.
const autotaskClient = axios.create({
  baseURL: process.env.AUTOTASK_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    // AutoTask REST API uses these two headers for authentication
    'UserName': process.env.AUTOTASK_USERNAME,
    'Secret': process.env.AUTOTASK_SECRET,
    'ApiIntegrationCode': process.env.AUTOTASK_USERNAME, // same as username for API users
  },
});

// Log errors in dev without leaking credentials
autotaskClient.interceptors.response.use(
  response => response,
  error => {
    const status = error.response?.status;
    const message = error.response?.data?.errors?.[0]?.message || error.message;
    console.error(`AutoTask API error [${status}]: ${message}`);
    return Promise.reject(error);
  }
);

module.exports = autotaskClient;
