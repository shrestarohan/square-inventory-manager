// lib/square.js
const { Client, Environment } = require("square/legacy");

function normalizeEnv(env = "production") {
  const e = String(env || "").toLowerCase();
  return e === "sandbox" ? "sandbox" : "production";
}

function createSquareOAuthClient(env) {
  const e = normalizeEnv(env);
  return new Client({
    environment: e === "sandbox" ? Environment.Sandbox : Environment.Production,
  });
}

function createSquareClient(accessToken, env = "production") {
  const e = normalizeEnv(env);
  return new Client({
    environment: e === "sandbox" ? Environment.Sandbox : Environment.Production,
    bearerAuthCredentials: { accessToken },
  });
}

function squareBaseUrl(env = "sandbox") {
  return normalizeEnv(env) === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function makeCreateSquareClientForMerchant({ firestore }) {
  if (!firestore) throw new Error("makeCreateSquareClientForMerchant requires firestore");

  return async function createSquareClientForMerchant({ merchantId }) {
    const snap = await firestore.collection("merchants").doc(merchantId).get();
    if (!snap.exists) throw new Error(`Merchant not found: ${merchantId}`);

    const m = snap.data() || {};
    const accessToken =
      m.square_access_token ||
      m.access_token ||
      m.accessToken ||
      m.squareAccessToken ||
      m.square?.access_token ||
      null;

    const env =
      m.square_env ||
      m.env ||
      m.square?.env ||
      process.env.SQUARE_ENV ||
      "production";

    if (!accessToken) throw new Error(`Missing Square access token for merchant ${merchantId}`);
    return createSquareClient(accessToken, env);
  };
}

module.exports = {
  createSquareOAuthClient,
  createSquareClient,
  squareBaseUrl,
  makeCreateSquareClientForMerchant,
};
