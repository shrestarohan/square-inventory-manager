require("../lib/loadEnv"); // adjust relative path

const firestore = require("../lib/firestore");
const { createSquareClient } = require("../lib/square"); // your lib/square.js

async function run() {
  const merchantId = process.env.MERCHANT_ID;
  if (!merchantId) throw new Error("Set MERCHANT_ID=...");

  const doc = await firestore.collection("merchants").doc(merchantId).get();
  if (!doc.exists) throw new Error(`Merchant not found: ${merchantId}`);

  const m = doc.data() || {};
  const env = (m.env || "production").toLowerCase();
  const token = m.access_token;

  console.log("Merchant:", merchantId);
  console.log("Env:", env);
  console.log("Token present:", !!token, "Length:", token ? token.length : 0);

  const square = createSquareClient(token, env); // expects env 'sandbox' or 'production'

  // simple, reliable check
  const res = await square.locationsApi.listLocations();
  const locs = res.result.locations || [];
  console.log("✅ Token OK. Locations:", locs.map(l => `${l.id}:${l.name}`).join(", "));
}

run().catch((e) => {
  console.error("❌ Token test failed:", e?.message || e);
  process.exit(1);
});
