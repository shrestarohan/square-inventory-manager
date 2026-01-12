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
 *       gtin_raws,                // optional debug (sample of raw digit forms)
 *       item_name,
 *       item_name_lc,
 *       category_name,
 *       sku,
 *       updated_at,
 *       has_mismatch,             // server-side filter
 *       price_spread,             // sorting / display
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
 *     {
 *       locKey,
 *       merchant_id,
 *       merchant_name,
 *       location_id,
 *       location_name,
 *       backfilled_at
 *     }
 *
 * USAGE
 *   DRY_RUN=1 node scripts/buildGtinInventoryMatrixConsolidated.js
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
 *   CLEAN_DERIVED=1            -> delete gtin_inventory_matrix + location_index before rebuild
 *   CONFIRM_DELETE=YES         -> required when CLEAN_DERIVED=1 (unless DRY_RUN=1)
 *   CLEAN_ONLY=1               -> delete then exit (no rebuild)
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

/**
 * Normalizes strings for cheap search keys.
 * Example: "Tito's 750 ml" -> "titos750ml"
 */
function makeSearchKey(s) {
  return safeStr(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function pickImageUrlFromInventoryDoc(d) {
  if (!d) return "";

  // Common field names you may have in Firestore inventory docs
  const direct = [
    d.image_url,
    d.imageUrl,
    d.image,
    d.photo_url,
    d.photoUrl,
    d.item_image_url,
    d.square_image_url,
    d.squareImageUrl,
    d.catalog_image_url,
  ].filter(Boolean);

  if (direct.length) return safeStr(direct[0]).trim();

  // Arrays
  if (Array.isArray(d.image_urls) && d.image_urls.length) return safeStr(d.image_urls[0]).trim();
  if (Array.isArray(d.imageUrls) && d.imageUrls.length) return safeStr(d.imageUrls[0]).trim();

  // Nested common patterns
  const nested =
    d?.images?.[0]?.url ||
    d?.images?.[0]?.image_url ||
    d?.images?.[0]?.imageUrl ||
    d?.item_image?.url ||
    d?.item_image?.image_url ||
    "";

  return safeStr(nested).trim();
}

// Keep the first good one found (simple & stable)
function chooseBestImageUrl(current, next) {
  const c = safeStr(current).trim();
  if (c) return c;

  const n = safeStr(next).trim();
  if (n) return n;

  return "";
}


async function deleteCollectionByQuery(colRef, pageSize = 450) {
  let totalDeleted = 0;

  while (true) {
    const snap = await colRef.orderBy("__name__").limit(pageSize).get();
    if (snap.empty) break;

    const batch = firestore.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);

    await batch.commit();
    totalDeleted += snap.size;

    // small progress log
    if (totalDeleted % (pageSize * 5) === 0) {
      console.log(`   ...deleted ${totalDeleted} so far from ${colRef.path}`);
    }
  }

  return totalDeleted;
}

async function cleanDerivedCollections({ dryRun, readPageSize }) {
  const confirm = String(process.env.CONFIRM_DELETE || "").trim().toUpperCase();
  const cleanOnly = !!process.env.CLEAN_ONLY;

  if (dryRun) {
    console.log("🧽 CLEAN_DERIVED requested but DRY_RUN=1, so no deletions will occur.");
    return { cleanOnly, deletedGtin: 0, deletedLoc: 0 };
  }

  if (confirm !== "YES") {
    throw new Error(
      "Refusing to delete collections: set CONFIRM_DELETE=YES (exact) when CLEAN_DERIVED=1"
    );
  }

  console.log("\n🧽 Cleaning derived collections BEFORE rebuild...");
  console.log("   Deleting: gtin_inventory_matrix");
  const deletedGtin = await deleteCollectionByQuery(
    firestore.collection("gtin_inventory_matrix"),
    Math.min(readPageSize, 450)
  );

  console.log("   Deleting: location_index");
  const deletedLoc = await deleteCollectionByQuery(
    firestore.collection("location_index"),
    Math.min(readPageSize, 450)
  );

  console.log(`✅ Clean complete. Deleted gtin_inventory_matrix=${deletedGtin}, location_index=${deletedLoc}`);
  return { cleanOnly, deletedGtin, deletedLoc };
}

/**
 * Builds a compact token set for fast array-contains search.
 * Captures:
 *  - words (vodka, titos)
 *  - merged size tokens (200ml, 750ml, 12pk, 1l, 0.5l)
 *  - sku tokens
 */
function makeSearchTokens(itemName, sku) {
  const tokens = new Set();

  const add = (t) => {
    const k = makeSearchKey(t);
    if (!k) return;
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
    add(skuStr);
  }

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

/**
 * Firestore-safe doc id from arbitrary text. (Keeps your existing approach.)
 */
function locIdForKey(locKey) {
  return Buffer.from(locKey, "utf8").toString("base64").replace(/=+$/g, "");
}

/**
 * ✅ locKey format (UPDATED):
 *   locKey: "<Square Merchant Name> – <Square Location Name>"
 *
 * Examples:
 *   "Patan Incorporated – Patan Incorporated (Main)"
 *   "Once Upon A Bottle Liquor – Plano #2"
 *
 * Notes:
 * - Merchant name prefers Square merchant label/map if you provide one,
 *   otherwise falls back to d.merchant_name, then merchantId.
 * - Location name prefers d.location_name, then falls back to location_id, then "Unknown Location".
 */
/**
 * ✅ locKey format (MERCHANT-ONLY):
 *   locKey: "<merchantName> – <merchantName>"
 *
 * One column per merchant regardless of Square location count.
 */
function makeLocKey(d, merchantId, merchantLabelMap) {
  // Stable key: one per merchant, forever
  return `${merchantId} – ${merchantId}`;
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

function getMerchantLabel(d, merchantId, merchantLabelMap) {
  const fromMap = safeStr(merchantLabelMap?.[merchantId]).trim();
  if (fromMap) return fromMap.replace(/\s+/g, " ");

  const fromDoc = safeStr(d?.merchant_name).trim();
  if (fromDoc && fromDoc !== merchantId) return fromDoc.replace(/\s+/g, " ");

  return safeStr(merchantId).trim();
}

// Metrics used for server-side mismatch filter
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

async function loadMerchantLabelMapFromDb(merchantIds) {
  const map = {};

  // Read merchant docs in parallel
  const snaps = await Promise.all(
    merchantIds.map((id) => firestore.collection("merchants").doc(id).get())
  );

  for (const doc of snaps) {
    if (!doc.exists) continue;
    const data = doc.data() || {};

    // ✅ pick whichever field you actually store
    const label =
      safeStr(data.label || data.name || data.merchant_name || data.display_name).trim();

    if (label) map[doc.id] = label.replace(/\s+/g, " ");
  }

  return map;
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
  const cleanDerived = !!(args.cleanDerived || process.env.CLEAN_DERIVED);

  const merchantIdArg = args.merchantId || process.env.TARGET_MERCHANT_ID || null;
  const merchantIds = merchantIdArg ? [merchantIdArg] : await listMerchantIds();

  // 1) Start with DB labels (best / stable)
  let merchantLabelMap = await loadMerchantLabelMapFromDb(merchantIds);

  // 2) Optional: ENV overrides DB (if provided)
  try {
    if (process.env.MERCHANT_LABELS) {
      const envMap = JSON.parse(process.env.MERCHANT_LABELS);
      merchantLabelMap = { ...merchantLabelMap, ...envMap };
    }
  } catch (_) {
    console.warn("⚠️ MERCHANT_LABELS is not valid JSON; ignoring.");
  }

  console.log("🏷️ Merchant labels resolved:", merchantLabelMap);

  const missingLabels = merchantIds.filter((id) => !safeStr(merchantLabelMap?.[id]).trim());
  if (missingLabels.length) {
    console.warn("⚠️ Missing MERCHANT_LABELS for:", missingLabels.join(", "));
    console.warn("   Set MERCHANT_LABELS env var so location_index can show names.");
  }


  console.log(`\n🔧 buildGtinInventoryMatrixConsolidated`);
  console.log(
    `   merchants=${merchantIds.length} dryRun=${dryRun} readPage=${readPageSize} writeBatch=${writeBatchSize}`
  );
  if (limitGtins) console.log(`   LIMIT_GTINS=${limitGtins}`);

  const outCol = firestore.collection("gtin_inventory_matrix");
  const locIndexCol = firestore.collection("location_index");

  if (cleanDerived) {
    const { cleanOnly } = await cleanDerivedCollections({ dryRun, readPageSize });
    if (cleanOnly) {
      console.log("🧼 CLEAN_ONLY=1 set. Exiting after cleanup.");
      return;
    }
  }

  // ✅ Store a richer location index so merchant_id is always present without any backfill script
  // Map<locKey, { locKey, merchant_id, merchant_name, location_id, location_name }>
  const locationIndex = new Map();

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

      // Aggregate per CANONICAL GTIN per page
      // Map<gtinKey, { gtin, gtin_raws, header, pricesByLocation }>
      const pageByGtin = new Map();

      for (const doc of snap.docs) {
        totalScanned++;
        const d = doc.data() || {};

        // canonicalize GTIN
        const gtinKey = canonicalGtin(d.gtin);
        if (!gtinKey) continue;

        // raw digits for debugging
        const gtinRawDigits = normalizeDigits(d.gtin);

        if (limitGtins) {
          uniqueCanonicalGtinsSeen.add(gtinKey);
          if (uniqueCanonicalGtinsSeen.size > limitGtins) {
            console.log(`🧪 LIMIT_GTINS reached (${limitGtins}). Stopping early.`);
            break;
          }
        }

        // ✅ Required locKey shape: "<MerchantLabel> – <MerchantLabel>"
        const locKey = makeLocKey(d, merchantId, merchantLabelMap);
        if (!locKey || locKey === "–") continue;

        // ✅ Upsert rich location index entry (no separate backfill needed)
        if (!locationIndex.has(locKey)) {
          const merchantLabel = getMerchantLabel(d, merchantId, merchantLabelMap) || merchantId;

          const locationId = safeStr(d.location_id || d.locationId).trim() || null;
          const locationName =
            safeStr(d.location_name || d.locationName).trim() ||
            (locationId ? locationId : "Unknown Location");

          locationIndex.set(locKey, {
            locKey,
            merchant_id: merchantId,
            merchant_name: merchantLabel,
            location_id: locationId,
            location_name: locationName,
          });
        } else {
          const cur = locationIndex.get(locKey);

          const merchantLabel = getMerchantLabel(d, merchantId, merchantLabelMap) || merchantId;
          const locationId = safeStr(d.location_id || d.locationId).trim() || null;
          const locationName = safeStr(d.location_name || d.locationName).trim() || null;

          if (merchantLabel && (!cur.merchant_name || cur.merchant_name === merchantId)) cur.merchant_name = merchantLabel;
          if (locationId && !cur.location_id) cur.location_id = locationId;
          if (locationName && (!cur.location_name || cur.location_name === "Unknown Location")) cur.location_name = locationName;
        }


        const price = d.price !== undefined && d.price !== null ? Number(d.price) : null;

        const candidateLocInfo = {
          price: Number.isFinite(price) ? price : null,
          currency: d.currency || null,

          merchant_id: d.merchant_id || merchantId || null,
          merchant_name: getMerchantLabel(d, merchantId, merchantLabelMap) || null,

          location_id: d.location_id || d.locationId || null,
          location_name: d.location_name || d.locationName || null,

          variation_id: d.variation_id || null,
          item_id: d.item_id || null,

          qty: d.qty ?? null,
          state: d.state || null,

          calculated_at: d.calculated_at || null,
          updated_at: d.updated_at || null,
        };

        // init / fetch aggregator
        let agg = pageByGtin.get(gtinKey);
        if (!agg) {
          agg = {
            gtin: gtinKey,
            gtin_raws: [],
            header: { item_name: "", category_name: "", sku: "", image_url: "" },
            pricesByLocation: {},
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

        // ✅ image_url (first non-empty wins)
        if (!agg.header.image_url) {
          const img = pickImageUrlFromInventoryDoc(d);
          if (img) agg.header.image_url = img;
        } else {
          // optional: if you want to allow replacement logic later
          // agg.header.image_url = chooseBestImageUrl(agg.header.image_url, pickImageUrlFromInventoryDoc(d));
        }

        // best loc info per (gtinKey, locKey)
        const prevLocInfo = agg.pricesByLocation[locKey];
        if (!prevLocInfo || shouldReplace(prevLocInfo, candidateLocInfo)) {
          agg.pricesByLocation[locKey] = candidateLocInfo;
        }
      }

      const nowIso = new Date().toISOString();

      for (const agg of pageByGtin.values()) {
        const gtinDoc = outCol.doc(agg.gtin);

        const itemName = agg.header.item_name || null;
        const sku = agg.header.sku || null;

        const nameKey = itemName ? makeSearchKey(itemName) : null;
        const skuKey = sku ? makeSearchKey(sku) : null;
        const searchTokens = makeSearchTokens(itemName, sku);
        const categoryName = agg.header.category_name || null;
        const categoryKey = categoryName ? makeSearchKey(categoryName) : null;

        const payload = {
          gtin: agg.gtin,
          ...(agg.gtin_raws && agg.gtin_raws.length ? { gtin_raws: agg.gtin_raws } : {}),
          ...(itemName ? { item_name: itemName, item_name_lc: itemName.toLowerCase() } : {}),
          ...(nameKey ? { name_key: nameKey } : {}),
          ...(agg.header.category_name ? { category_name: agg.header.category_name } : {}),
          ...(sku ? { sku } : {}),
          ...(skuKey ? { sku_key: skuKey } : {}),
          ...(searchTokens.length ? { search_tokens: searchTokens } : {}),
          ...(agg.header.image_url ? { image_url: agg.header.image_url } : {}),
          ...(categoryName ? { category_name: categoryName } : {}),
          ...(categoryKey ? { category_key: categoryKey } : {}),
          pricesByLocation: agg.pricesByLocation,
          updated_at: nowIso,
        };

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

  // ✅ Write global location_index with merchant_id baked in (no backfill script needed)
  console.log(`\n🧭 Writing location_index (${locationIndex.size} keys)`);
  if (!dryRun) {
    const rows = Array.from(locationIndex.values()).sort((a, b) => a.locKey.localeCompare(b.locKey));
    let locBatch = firestore.batch();
    let locWrites = 0;

    const nowIso2 = new Date().toISOString();

    for (const r of rows) {
      const docId = locIdForKey(r.locKey);

      locBatch.set(
        locIndexCol.doc(docId),
        {
          locKey: r.locKey,
          merchant_id: r.merchant_id || null,
          merchant_name: r.merchant_name || null,
          location_id: r.location_id || null,
          location_name: r.location_name || null,
          backfilled_at: nowIso2,
        },
        { merge: true }
      );

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
  console.log(`   locKeys: ${locationIndex.size}`);
}

// keep your existing run() as-is
async function buildGtinInventoryMatrixConsolidated() {
  return run();
}

if (require.main === module) {
  buildGtinInventoryMatrixConsolidated().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

module.exports = { buildGtinInventoryMatrixConsolidated };
