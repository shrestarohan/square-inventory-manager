// lib/squareClient.js
const { Client, Environment } = require('square/legacy');

function createSquareClient(accessToken, env) {
  return new Client({
    environment: (env === 'sandbox') ? Environment.Sandbox : Environment.Production,
    bearerAuthCredentials: { accessToken },
  });
}

module.exports = { createSquareClient };
