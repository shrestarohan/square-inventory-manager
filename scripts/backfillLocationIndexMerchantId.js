// scripts/backfillLocationIndexMerchantId.js
require("dotenv").config();
const firestore = require("../lib/firestore");

function normalize(s) {
  return (s || "")
    .toString()
    .replace(/\s*-\s*/g, " – ")   // hyphen
    .replace(/\s*—\s*/g, " – ")   // em dash
    .replace(/\s*–\s*/g, " – ")   // en dash
    .replace(/\s+/g, " ")
    .trim();
}

function splitLocKey(locKey) {
  const k = normalize(locKey);
  const parts = k.split(" – ").map(p => p.trim());
  return {
    merchantPart: parts[0] || "",
    locationPart: parts[1] || "",
  };
}

(async () => {
  const locSnap = await firestore.collection("location_index").get();
  const merchSnap = await firestore.collection("merchants").get();

  const merchants = merchSnap.docs.map(d => ({
    id: d.id,
    ...(d.data() || {}),
  }));

  // Build lookup by many possible merchant name fields (trimmed + normalized)
  const byMerchantName = new Map();
  for (const m of merchants) {
    const candidates = [
      m.business_name,
      m.merchant_name,
      m.name,
      m.display_name,
      m.square_merchant_name,
      m.squareBusinessName,
    ]
      .filter(Boolean)
      .map(normalize);

    for (const c of candidates) {
      if (c && !byMerchantName.has(c)) byMerchantName.set(c, m.id);
    }
  }

  let updated = 0;
  let skipped = 0;
  let noMatch = 0;

  for (const doc of locSnap.docs) {
    const data = doc.data() || {};
    const locKeyRaw = (data.locKey || doc.id || "").toString();
    const locKey = normalize(locKeyRaw);

    if (data.merchant_id) {
      skipped++;
      continue;
    }

    const { merchantPart, locationPart } = splitLocKey(locKey);

    // Try exact match on merchantPart first
    let mid = byMerchantName.get(normalize(merchantPart));

    // Fallback: sometimes locKey might be just merchant name (no dash)
    if (!mid) mid = byMerchantName.get(locKey);

    if (!mid) {
      console.log("No merchant match for:", { locKey, merchantPart, locationPart });
      noMatch++;
      continue;
    }

    await doc.ref.set(
      {
        merchant_id: mid,
        merchant_name: data.merchant_name || merchantPart || null,
        location_name: data.location_name || locationPart || null,
        locKey,
        backfilled_at: new Date().toISOString(),
      },
      { merge: true }
    );

    updated++;
    console.log("✅ Updated location_index:", locKey, "=> merchant_id:", mid);
  }

  console.log("Done.", { updated, skipped, noMatch, total: locSnap.size });
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
