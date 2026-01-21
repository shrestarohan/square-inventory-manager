/**
 * scripts/buildGtinInventoryMatrix.js
 * ============================================================
 * PURPOSE
 *   Builds a merchant-level inventory GTIN matrix for your
 *   Price Mismatch dashboard (prices across locations).
 *
 * READS FROM
 *   merchants/{merchantId}/inventory
 *
 * WRITES TO
 *   merchants/{merchantId}/gtin_inventory_matrix/{gtin}
 *     {
 *       gtin,
 *       item_name,
 *       item_name_lc,
 *       category_name,
 *       sku,
 *       updated_at,
 *       pricesByLocation: {
 *         "<locKey>": { merchant_id, location_id, location_name, variation_id, price, currency, qty, state, calculated_at }
 *       }
 *     }
 *
 *   merchants/{merchantId}/location_index/{id}
 *     { locKey }
 *
 * RUN
 *   node scripts/buildGtinInventoryMatrix.js --merchantId=ML1AH5AM3K151
 *   node scripts/buildGtinInventoryMatrix.js           # all merchants
 *   DRY_RUN=1 node scripts/buildGtinInventoryMatrix.js --merchantId=...
 * ============================================================
 */

require("../lib/loadEnv"); // adjust relative path
const firestore = require("../lib/firestore");

const DEFAULT_READ_PAGE = 1000;
const DEFAULT_WRITE_BATCH = 400;

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    out[k] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function safeStr(v) {
  return v === null || v === undefined ? "" : String(v);
}

function makeLocKey(d) {
  // Prefer readable merchant + location names if present
  const merchantName = safeStr(d.merchant_name || d.merchant_id).trim();
  const locationName = safeStr(d.location_name || d.location_id).trim();
  return `${merchantName} – ${locationName}`.trim();
}

// Prefer: has price > no price, then latest calculated_at/updated_at
function shouldReplace(existing, candidate) {
  if (!existing) return true;

  const ep = existing.price === null || existing.price === undefined ? null : Number(existing.price);
  const cp = candidate.price === null || candidate.price === undefined ? null : Number(candidate.price);

  if (ep === null && cp !== null) return true;
  if (ep !== null && cp === null) return false;

  const eTime = Date.parse(existing.calculated_at || existing.updated_at || "") || 0;
  const cTime = Date.parse(candidate.calculated_at || candidate.updated_at || "") || 0;
  return cTime >= eTime;
}

function locIdForKey(locKey) {
  return Buffer.from(locKey, "utf8").toString("base64").replace(/=+$/g, "");
}

async function listAllMerchantIds() {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map((d) => d.id);
}

async function buildForOneMerchant(merchantId, { readPageSize, writeBatchSize, dryRun }) {
  const sourceCol = firestore.collection("merchants").doc(merchantId).collection("inventory");
  const outCol = firestore.collection("merchants").doc(merchantId).collection("gtin_inventory_matrix");
  const locCol = firestore.collection("merchants").doc(merchantId).collection("location_index");

  console.log(`\n🔧 Inventory GTIN matrix: merchants/${merchantId}/inventory → merchants/${merchantId}/gtin_inventory_matrix`);
  console.log(`   readPageSize=${readPageSize} writeBatchSize=${writeBatchSize} dryRun=${dryRun}`);

  let lastDoc = null;
  let scanned = 0;

  const locationKeys = new Set();

  let batch = firestore.batch();
  let batchWrites = 0;
  let wroteEntries = 0;

  async function commit(force = false) {
    if (batchWrites === 0) return;
    if (!force && batchWrites < writeBatchSize) return;
    if (!dryRun) await batch.commit();
    batch = firestore.batch();
    batchWrites = 0;
  }

  while (true) {
    let q = sourceCol.orderBy("__name__").limit(readPageSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    // per-page best candidate per (gtin||locKey)
    const pageBest = new Map();

    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data() || {};

      const gtin = d.gtin ? String(d.gtin).trim() : "";
      if (!gtin) continue;

      const locKey = makeLocKey(d);
      if (!locKey || locKey === "–") continue;
      locationKeys.add(locKey);

      const price = d.price !== undefined && d.price !== null ? Number(d.price) : null;

      const candidateLocInfo = {
        price: Number.isFinite(price) ? price : null,
        currency: d.currency || null,
        merchant_id: d.merchant_id || merchantId || null,
        merchant_name: d.merchant_name || null,
        location_id: d.location_id || null,
        location_name: d.location_name || null,
        variation_id: d.variation_id || null,
        item_id: d.item_id || null,
        qty: d.qty ?? null,
        state: d.state || null,
        calculated_at: d.calculated_at || null,
        updated_at: d.updated_at || null,
      };

      const key = `${gtin}||${locKey}`;
      const prev = pageBest.get(key);

      if (!prev || shouldReplace(prev.locInfo, candidateLocInfo)) {
        const itemName = safeStr(d.item_name).trim();
        const categoryName = safeStr(d.category_name).trim();
        const sku = safeStr(d.sku).trim();

        pageBest.set(key, {
          gtin,
          locKey,
          locInfo: candidateLocInfo,
          header: {
            item_name: itemName,
            category_name: categoryName,
            sku: sku,
          },
        });
      }
    }

    const nowIso = new Date().toISOString();

    // write once per unique (gtin, locKey) in this page
    for (const entry of pageBest.values()) {
      const gtinDoc = outCol.doc(entry.gtin);

      const itemName = entry.header.item_name || null;

      const payload = {
        gtin: entry.gtin,
        ...(itemName ? { item_name: itemName, item_name_lc: itemName.toLowerCase() } : {}),
        ...(entry.header.category_name ? { category_name: entry.header.category_name } : {}),
        ...(entry.header.sku ? { sku: entry.header.sku } : {}),
        pricesByLocation: {
          [entry.locKey]: entry.locInfo,
        },
        updated_at: nowIso,
      };

      batch.set(gtinDoc, payload, { merge: true });
      batchWrites++;
      wroteEntries++;

      if (batchWrites >= writeBatchSize) await commit(true);
    }

    await commit(false);
    lastDoc = snap.docs[snap.docs.length - 1];

    console.log(`   scanned=${scanned} wroteEntries=${wroteEntries} lastDoc=${lastDoc.id}`);
  }

  // write merchant-scoped location_index
  console.log(`   Writing merchants/${merchantId}/location_index (${locationKeys.size} keys)`);

  const locArr = Array.from(locationKeys).sort();
  if (!dryRun) {
    let locBatch = firestore.batch();
    let locWrites = 0;

    for (const locKey of locArr) {
      locBatch.set(locCol.doc(locIdForKey(locKey)), { locKey }, { merge: true });
      locWrites++;
      if (locWrites >= 450) {
        await locBatch.commit();
        locBatch = firestore.batch();
        locWrites = 0;
      }
    }
    if (locWrites) await locBatch.commit();
  }

  console.log(`✅ Done merchant ${merchantId}. scanned=${scanned} wroteEntries=${wroteEntries}`);
}

async function run() {
  const args = parseArgs(process.argv);

  const merchantIdArg = args.merchantId || process.env.TARGET_MERCHANT_ID || null;
  const dryRun = !!(args.dryRun || process.env.DRY_RUN);

  const readPageSize = Math.min(Number(args.readPage || process.env.READ_PAGE) || DEFAULT_READ_PAGE, 2000);
  const writeBatchSize = Math.min(Number(args.writeBatch || process.env.BATCH_SIZE) || DEFAULT_WRITE_BATCH, 450);

  const merchantIds = merchantIdArg ? [merchantIdArg] : await listAllMerchantIds();

  console.log(`\n🚀 buildGtinInventoryMatrix`);
  console.log(`   merchants=${merchantIds.length} dryRun=${dryRun} readPage=${readPageSize} writeBatch=${writeBatchSize}`);

  for (const mid of merchantIds) {
    try {
      await buildForOneMerchant(mid, { readPageSize, writeBatchSize, dryRun });
    } catch (e) {
      console.error(`❌ Merchant ${mid} failed:`, e?.message || e);
    }
  }

  console.log(`\n✅ All done.`);
}

if (require.main === module) {
  run().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

module.exports = { run };
