/**
 * scripts/cleanupEmptyVariationForGtin.js
 * ============================================================
 * PURPOSE
 *   Clean up bad/placeholder records where:
 *     - gtin == TARGET_GTIN
 *     - variation_id (or variationId) is empty / missing
 *
 * DOES TWO THINGS
 *   A) gtin_inventory_matrix/<GTIN>
 *      - Removes any pricesByLocation entries whose variation_id is empty
 *      - Recalculates priced_location_count, min/max, price_spread, has_mismatch
 *
 *   B) merchants/{merchantId}/inventory
 *      - Finds inventory docs with gtin == TARGET_GTIN and variation_id empty
 *      - Deletes those docs (recommended, because they are not actionable)
 *
 * OPTIONS (env)
 *   TARGET_GTIN=CBJJMIX04     (required; default: CBJJMIX04)
 *   DRY_RUN=1                -> no writes/deletes, only logs
 *   TARGET_MERCHANT_ID=ML... -> only clean that merchant subcollection
 *
 * RUN
 *   DRY_RUN=1 TARGET_GTIN=00001425 node scripts/cleanupEmptyVariationForGtin.js
 *   DRY_RUN=0 TARGET_GTIN=00001425 node scripts/cleanupEmptyVariationForGtin.js
 */


require("../lib/loadEnv"); // adjust relative path
const firestore = require("../lib/firestore");
const { canonicalGtin } = require("../lib/gtin");

function nowIso() {
  return new Date().toISOString();
}

function isBlank(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s.length === 0;
}

function getVariationId(obj) {
  return (
    obj?.variation_id ??
    obj?.variationId ??
    obj?.variation ??
    obj?.variationID ??
    null
  );
}

function getPrice(obj) {
  const p = obj?.price;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

function computeSpread(prices) {
  const nums = prices.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!nums.length) return { min: null, max: null, spread: 0, mismatch: false };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const spread = max - min;
  const mismatch = nums.length > 1 && spread > 0.0001;
  return { min, max, spread, mismatch };
}

async function cleanupMatrixDoc(gtin, dryRun) {
  const ref = firestore.collection("gtin_inventory_matrix").doc(gtin);
  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`✅ Matrix doc not found: gtin_inventory_matrix/${gtin}`);
    return;
  }

  const data = snap.data() || {};
  const pb =
    data.pricesByLocation ||
    data.prices_by_location ||
    data.locations ||
    {};

  const beforeKeys = Object.keys(pb || {});
  let removed = 0;

  const cleaned = {};
  for (const [locKey, info] of Object.entries(pb || {})) {
    const vid = getVariationId(info);
    if (isBlank(vid)) {
      removed++;
      continue; // drop this location entry
    }
    cleaned[locKey] = info;
  }

  const prices = Object.values(cleaned).map(getPrice).filter((x) => x != null);
  const { min, max, spread, mismatch } = computeSpread(prices);

  const patch = {
    pricesByLocation: cleaned,
    priced_location_count: prices.length,
    min_price: min,
    max_price: max,
    price_spread: spread,
    has_mismatch: mismatch,
    updated_at: nowIso(),
  };

  console.log(
    `\n=== MATRIX CLEANUP: ${gtin} ===\n` +
      `Before locations: ${beforeKeys.length}\n` +
      `Removed empty-variation entries: ${removed}\n` +
      `After locations: ${Object.keys(cleaned).length}\n` +
      `priced_location_count: ${prices.length}\n` +
      `min/max/spread: ${min}/${max}/${spread}\n`
  );

  if (dryRun) {
    console.log("DRY_RUN=1 -> would update matrix doc with:", patch);
    return;
  }

  await ref.set(patch, { merge: true });
  console.log(`✅ Updated matrix doc: gtin_inventory_matrix/${gtin}`);
}

async function cleanupMerchantInventories(gtin, dryRun, targetMerchantId) {
  console.log(`\n=== MERCHANT INVENTORY CLEANUP: gtin=${gtin} ===`);

  // Scan merchants
  const merchantsSnap = targetMerchantId
    ? await firestore.collection("merchants").doc(targetMerchantId).get().then((d) => ({
        empty: !d.exists,
        docs: d.exists ? [d] : [],
      }))
    : await firestore.collection("merchants").get();

  const merchantDocs = merchantsSnap.docs || merchantsSnap.docs === undefined ? (merchantsSnap.docs || []) : merchantsSnap.docs;
  const merchants = (targetMerchantId ? merchantDocs : merchantsSnap.docs).map((d) => ({ id: d.id }));

  if (targetMerchantId && merchants.length === 0) {
    console.log(`⚠️ merchants/${targetMerchantId} not found`);
    return;
  }

  let totalMatches = 0;
  let totalDeletes = 0;

  for (const m of merchants) {
    const merchantId = m.id;

    // We try a few ways because your inventory schema may vary:
    // - gtin field stored as canonical string
    // - docId might be item_id or something else
    const invRef = firestore.collection("merchants").doc(merchantId).collection("inventory");

    // Query #1: gtin == gtin
    // Query #2: gtin == canonical(gtin) (if canonicalizer changes it)
    const gtinCanonical = canonicalGtin(gtin) || gtin;

    const queries = [];
    queries.push(invRef.where("gtin", "==", gtin));
    if (gtinCanonical !== gtin) queries.push(invRef.where("gtin", "==", gtinCanonical));

    // Merge results (avoid duplicates)
    const seenIds = new Set();
    const hits = [];

    for (const q of queries) {
      const snap = await q.get();
      for (const d of snap.docs) {
        if (seenIds.has(d.id)) continue;
        seenIds.add(d.id);
        hits.push(d);
      }
    }

    if (!hits.length) continue;

    // Filter where variation_id is empty
    const bad = hits.filter((d) => {
      const data = d.data() || {};
      const vid = getVariationId(data);
      return isBlank(vid);
    });

    if (!bad.length) continue;

    totalMatches += bad.length;

    console.log(
      `\nMerchant ${merchantId}: found ${bad.length} inventory docs with gtin=${gtin} and empty variation_id`
    );

    // Delete in batches (Firestore limit 500 ops/batch)
    const BATCH_SIZE = 400;
    for (let i = 0; i < bad.length; i += BATCH_SIZE) {
      const chunk = bad.slice(i, i + BATCH_SIZE);

      if (dryRun) {
        chunk.forEach((d) => console.log(`DRY_RUN=1 -> would delete merchants/${merchantId}/inventory/${d.id}`));
        continue;
      }

      const batch = firestore.batch();
      chunk.forEach((d) => batch.delete(d.ref));
      await batch.commit();

      totalDeletes += chunk.length;
      console.log(`✅ Deleted ${chunk.length} docs from merchants/${merchantId}/inventory`);
    }
  }

  console.log(
    `\n=== SUMMARY ===\n` +
      `Total bad inventory docs matched: ${totalMatches}\n` +
      `Total deleted: ${dryRun ? 0 : totalDeletes}\n`
  );
}

async function main() {
  const dryRun = String(process.env.DRY_RUN || "1") === "1";
  const targetGtinRaw = (process.env.TARGET_GTIN || "CBJJMIX04").trim();
  const targetMerchantId = (process.env.TARGET_MERCHANT_ID || "").trim() || null;

  if (!targetGtinRaw) {
    console.error("TARGET_GTIN is required");
    process.exit(1);
  }

  const gtin = canonicalGtin(targetGtinRaw) || targetGtinRaw;

  console.log("============================================================");
  console.log("cleanupEmptyVariationForGtin.js");
  console.log("DRY_RUN =", dryRun);
  console.log("TARGET_GTIN =", gtin);
  console.log("TARGET_MERCHANT_ID =", targetMerchantId || "(all)");
  console.log("============================================================");

  // A) Matrix doc cleanup
  await cleanupMatrixDoc(gtin, dryRun);

  // B) Merchant inventory cleanup
  await cleanupMerchantInventories(gtin, dryRun, targetMerchantId);

  console.log("\n✅ Done.");
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
