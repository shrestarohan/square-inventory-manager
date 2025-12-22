// lib/square.js
const { Client, Environment } = require("square/legacy");

function createSquareOAuthClient(env) {
  return new Client({
    environment: env === "sandbox" ? Environment.Sandbox : Environment.Production,
  });
}

function createSquareClient(accessToken, env = "production") {
  return new Client({
    environment: env === "sandbox" ? Environment.Sandbox : Environment.Production,
    bearerAuthCredentials: { accessToken },
  });
}

function squareBaseUrl(env = "sandbox") {
  return env === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

/**
 * Factory: returns an async function that builds a Square client for a merchantId
 * Usage:
 *   const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });
 *   const square = await createSquareClientForMerchant({ merchantId });
 */
function makeCreateSquareClientForMerchant({ firestore }) {
  if (!firestore) throw new Error("makeCreateSquareClientForMerchant requires firestore");

  return async function createSquareClientForMerchant({ merchantId }) {
    if (!merchantId) throw new Error("merchantId required");

    const snap = await firestore.collection("merchants").doc(merchantId).get();
    if (!snap.exists) throw new Error(`Merchant not found: ${merchantId}`);

    const m = snap.data() || {};

    // ✅ adjust these keys to your schema
    const accessToken =
      m.square_access_token ||
      m.access_token ||
      m.accessToken ||
      m.squareAccessToken ||
      null;

    const env =
      m.square_env ||
      m.env ||
      process.env.SQUARE_ENV ||
      "production";

    if (!accessToken) throw new Error(`Missing Square access token for merchant ${merchantId}`);

    console.log("[SquareClient] merchant", merchantId, "env=", env, "token?", !!accessToken);
    return createSquareClient(accessToken, env);
  };
}

module.exports = {
  createSquareOAuthClient,
  createSquareClient,
  squareBaseUrl,
  makeCreateSquareClientForMerchant,
};
