/**
 * scripts/buildGtinInventoryMatrixConsolidated.js
 * ============================================================
 * PURPOSE
 *   Build a consolidated GTIN inventory matrix used by the
 *   Price Mismatch dashboard (global, no merchant dropdown).
 *
 * READS FROM (recommended)
 *   merchants/{merchantId}/inventory
 *
 * WRITES TO (global)
 *   gtin_inventory_matrix/{gtin}
 *     {
 *       gtin,
 *       gtin_raws,                // ✅ optional debug (sample of raw digit forms)
 *       item_name,
 *       item_name_lc,
 *       category_name,
 *       sku,
 *       updated_at,
 *       has_mismatch,             // ✅ server-side filter
 *       price_spread,             // ✅ sorting / display
 *       min_price,
 *       max_price,
 *       priced_location_count,
 *       pricesByLocation: {
 *         "<locKey>": {
 *           merchant_id,
 *           merchant_name,
 *           location_id,
 *           location_name,
 *           variation_id,
 *           item_id,
 *           price,
 *           currency,
 *           qty,
 *           state,
 *           calculated_at,
 *           updated_at
 *         }
 *       }
 *     }
 *
 *   location_index/{id}
 *     { locKey }
 *
 * USAGE
 *   DRY_RUN=1 node scripts/buildGtinInventoryMatrixConsolidated.js
 *   node scripts/buildGtinInventoryMatrixConsolidated.js
 *
 *   # Limit to one merchant:
 *   TARGET_MERCHANT_ID=ML1... node scripts/buildGtinInventoryMatrixConsolidated.js
 *
 *   # Or via args:
 *   node scripts/buildGtinInventoryMatrixConsolidated.js --merchantId=ML1AH5AM3K151
 *
 * OPTIONAL ENV / ARGS
 *   DRY_RUN=1
 *   LIMIT_GTINS=200
 *   READ_PAGE=1000
 *   WRITE_BATCH=400
 *
 *   MERCHANT_LABELS='{"ML1...":"Plano","MLRE...":"GP1","MLTW...":"Fort Worth"}'
 * ============================================================
 */

require("../lib/loadEnv"); // adjust relative path
const firestore = require("../lib/firestore");

const { canonicalGtin, normalizeDigits } = require("../lib/gtin");

const DEFAULT_READ_PAGE = 1000;
const DEFAULT_WRITE_BATCH = 400;

function safeStr(v) {
  return v === null || v === undefined ? "" : String(v);
}

function makeSearchKey(s) {
  return safeStr(s)
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, "")          // remove spaces
    .replace(/[^a-z0-9]/g, "");     // remove punctuation (optional but recommended)
}

function makeSearchKey(s) {
  return safeStr(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Builds a compact token set for fast array-contains search.
 * Captures:
 *  - words (vodka, titos)
 *  - merged size tokens (200ml, 750ml, 12pk, 1l, 0.5l)
 *  - numeric tokens (200, 750) (optional but helpful)
 */
function makeSearchTokens(itemName, sku) {
  const tokens = new Set();

  const add = (t) => {
    const k = makeSearchKey(t);
    if (!k) return;
    // Keep tokens reasonable (avoid huge arrays)
    if (k.length > 2 && k.length <= 24) tokens.add(k);
  };

  const name = safeStr(itemName).toLowerCase();
  const skuStr = safeStr(sku).toLowerCase();

  // split on non-alnum
  const parts = name.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/g).filter(Boolean);

  // basic word tokens
  for (const p of parts) add(p);

  // merge adjacent number + unit => 200 ml -> 200ml
  for (let i = 0; i < parts.length - 1; i++) {
    const a = parts[i], b = parts[i + 1];
    if (/^\d+(\.\d+)?$/.test(a) && /^[a-z]+$/.test(b)) add(`${a}${b}`);
  }

  // capture tokens already written like "200ml" or "12pk"
  const fused = name.match(/\d+(\.\d+)?[a-z]+/g) || [];
  for (const t of fused) add(t);

  // sku tokens (optional)
  if (skuStr) {
    const skuParts = skuStr.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/g).filter(Boolean);
    for (const p of skuParts) add(p);
    // also add fused sku key
    add(skuStr);
  }

  // cap array size (Firestore doc size safety + index costs)
  return Array.from(tokens).slice(0, 40);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    out[k] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function locIdForKey(locKey) {
  return Buffer.from(locKey, "utf8").toString("base64").replace(/=+$/g, "");
}

/**
 * locKey should be stable and match the UI columns you want.
 * If you want EXACT store names, set MERCHANT_LABELS in env:
 *   MERCHANT_LABELS='{"ML1...":"Plano","MLRE...":"GP1","MLTW...":"Fort Worth"}'
 */
function makeLocKey(d, merchantId, merchantLabelMap) {
  const label = merchantLabelMap?.[merchantId] || safeStr(d.merchant_name || merchantId).trim();
  const locName = safeStr(d.location_name || d.location_id || "Default").trim();
  return `${label} – ${locName}`.trim();
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

// ✅ Metrics used for server-side mismatch filter
function computeMismatchMetrics(pricesByLocation) {
  const priced = Object.values(pricesByLocation || {})
    .map((x) => (x && x.price !== null && x.price !== undefined ? Number(x.price) : null))
    .filter((p) => Number.isFinite(p));

  if (priced.length < 2) {
    return {
      priced_location_count: priced.length,
      min_price: priced.length ? priced[0] : null,
      max_price: priced.length ? priced[0] : null,
      price_spread: 0,
      has_mismatch: false,
    };
  }

  const min = Math.min(...priced);
  const max = Math.max(...priced);
  const spread = max - min;

  return {
    priced_location_count: priced.length,
    min_price: min,
    max_price: max,
    price_spread: spread,
    has_mismatch: spread > 0,
  };
}

async function listMerchantIds() {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map((d) => d.id);
}

async function run() {
  const args = parseArgs(process.argv);

  const dryRun = !!(args.dryRun || process.env.DRY_RUN);

  const readPageSize = Math.min(
    Number(args.readPage || process.env.READ_PAGE) || DEFAULT_READ_PAGE,
    2000
  );
  const writeBatchSize = Math.min(
    Number(args.writeBatch || process.env.WRITE_BATCH) || DEFAULT_WRITE_BATCH,
    450
  );

  const limitGtins = Number(args.limitGtins || process.env.LIMIT_GTINS) || null;

  const merchantIdArg = args.merchantId || process.env.TARGET_MERCHANT_ID || null;
  const merchantIds = merchantIdArg ? [merchantIdArg] : await listMerchantIds();

  let merchantLabelMap = {};
  try {
    if (process.env.MERCHANT_LABELS) merchantLabelMap = JSON.parse(process.env.MERCHANT_LABELS);
  } catch (_) {
    console.warn("⚠️ MERCHANT_LABELS is not valid JSON; ignoring.");
  }

  console.log(`\n🔧 buildGtinInventoryMatrixConsolidated`);
  console.log(
    `   merchants=${merchantIds.length} dryRun=${dryRun} readPage=${readPageSize} writeBatch=${writeBatchSize}`
  );
  if (limitGtins) console.log(`   LIMIT_GTINS=${limitGtins}`);

  const outCol = firestore.collection("gtin_inventory_matrix");
  const locIndexCol = firestore.collection("location_index");

  const locationKeys = new Set();

  let totalScanned = 0;
  let totalWrote = 0;

  // Track canonical GTINs when LIMIT_GTINS is set (so the limit works after canonicalization)
  const uniqueCanonicalGtinsSeen = new Set();

  let batch = firestore.batch();
  let batchWrites = 0;

  async function commit(force = false) {
    if (batchWrites === 0) return;
    if (!force && batchWrites < writeBatchSize) return;
    if (!dryRun) await batch.commit();
    batch = firestore.batch();
    batchWrites = 0;
  }

  for (const merchantId of merchantIds) {
    console.log(`\n📦 Merchant ${merchantId}: scanning merchants/${merchantId}/inventory ...`);

    const sourceCol = firestore.collection("merchants").doc(merchantId).collection("inventory");

    let lastDoc = null;
    while (true) {
      let q = sourceCol.orderBy("__name__").limit(readPageSize);
      if (lastDoc) q = q.startAfter(lastDoc);

      const snap = await q.get();
      if (snap.empty) break;

      // ✅ Aggregate per CANONICAL GTIN per page (lets us compute mismatch metrics)
      // Map<gtinKey, { gtin, gtin_raws, header, pricesByLocation }>
      const pageByGtin = new Map();

      for (const doc of snap.docs) {
        totalScanned++;
        const d = doc.data() || {};

        // ✅ canonicalize GTIN
        const gtinKey = canonicalGtin(d.gtin);
        if (!gtinKey) continue;

        // raw digits for debugging (shows why duplicates used to happen)
        const gtinRawDigits = normalizeDigits(d.gtin);

        if (limitGtins) {
          uniqueCanonicalGtinsSeen.add(gtinKey);
          if (uniqueCanonicalGtinsSeen.size > limitGtins) {
            console.log(`🧪 LIMIT_GTINS reached (${limitGtins}). Stopping early.`);
            break;
          }
        }

        const locKey = makeLocKey(d, merchantId, merchantLabelMap);
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

        // init / fetch aggregator (by canonical GTIN)
        let agg = pageByGtin.get(gtinKey);
        if (!agg) {
          agg = {
            gtin: gtinKey,
            // keep a small sample of raw variants seen (avoid huge arrays)
            gtin_raws: [],
            header: { item_name: "", category_name: "", sku: "" },
            pricesByLocation: {}, // locKey -> locInfo
          };
          pageByGtin.set(gtinKey, agg);
        }

        // record raw digits (up to 5 unique)
        if (gtinRawDigits) {
          const arr = agg.gtin_raws;
          if (!arr.includes(gtinRawDigits) && arr.length < 5) arr.push(gtinRawDigits);
        }

        // headers (first non-empty wins)
        if (!agg.header.item_name) agg.header.item_name = safeStr(d.item_name).trim();
        if (!agg.header.category_name) agg.header.category_name = safeStr(d.category_name).trim();
        if (!agg.header.sku) agg.header.sku = safeStr(d.sku).trim();

        // best loc info per (gtinKey, locKey)
        const prevLocInfo = agg.pricesByLocation[locKey];
        if (!prevLocInfo || shouldReplace(prevLocInfo, candidateLocInfo)) {
          agg.pricesByLocation[locKey] = candidateLocInfo;
        }
      }

      const nowIso = new Date().toISOString();

      for (const agg of pageByGtin.values()) {
        const gtinDoc = outCol.doc(agg.gtin); // ✅ doc id uses CANONICAL GTIN

        const itemName = agg.header.item_name || null;
        const sku = agg.header.sku || null;

        const nameKey = itemName ? makeSearchKey(itemName) : null;
        const skuKey = sku ? makeSearchKey(sku) : null;
        const searchTokens = makeSearchTokens(itemName, sku);

        const payload = {
          gtin: agg.gtin,
          ...(agg.gtin_raws && agg.gtin_raws.length ? { gtin_raws: agg.gtin_raws } : {}),
          ...(itemName ? { item_name: itemName, item_name_lc: itemName.toLowerCase() } : {}),
          ...(nameKey ? { name_key: nameKey } : {}),
          ...(agg.header.category_name ? { category_name: agg.header.category_name } : {}),
          ...(sku ? { sku } : {}),
          ...(skuKey ? { sku_key: skuKey } : {}),
          ...(searchTokens.length ? { search_tokens: searchTokens } : {}),
          pricesByLocation: agg.pricesByLocation,
          updated_at: nowIso,
        };


        // ✅ Add mismatch metrics for fast server-side filtering
        Object.assign(payload, computeMismatchMetrics(payload.pricesByLocation));

        batch.set(gtinDoc, payload, { merge: true });
        batchWrites++;
        totalWrote++;

        if (batchWrites >= writeBatchSize) await commit(true);
      }

      await commit(false);

      lastDoc = snap.docs[snap.docs.length - 1];
      console.log(`   scanned=${totalScanned} wrote=${totalWrote} lastDoc=${lastDoc.id}`);

      if (limitGtins && uniqueCanonicalGtinsSeen.size >= limitGtins) break;
    }

    if (limitGtins && uniqueCanonicalGtinsSeen.size >= limitGtins) break;
  }

  // Final commit
  await commit(true);

  // Write global location_index
  console.log(`\n🧭 Writing location_index (${locationKeys.size} keys)`);
  if (!dryRun) {
    const locArr = Array.from(locationKeys).sort();
    let locBatch = firestore.batch();
    let locWrites = 0;

    for (const locKey of locArr) {
      locBatch.set(locIndexCol.doc(locIdForKey(locKey)), { locKey }, { merge: true });
      locWrites++;
      if (locWrites >= 450) {
        await locBatch.commit();
        locBatch = firestore.batch();
        locWrites = 0;
      }
    }
    if (locWrites) await locBatch.commit();
  }

  console.log(`\n✅ Done.`);
  console.log(`   total scanned docs: ${totalScanned}`);
  console.log(`   total wrote entries: ${totalWrote}`);
  console.log(`   canonical gtins seen: ${uniqueCanonicalGtinsSeen.size}`);
  console.log(`   locKeys: ${locationKeys.size}`);
}

if (require.main === module) {
  run().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

module.exports = { run };
