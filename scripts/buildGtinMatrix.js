/**
 * scripts/buildGtinMatrix.js
 * ============================================================================
 * PURPOSE
 *   Build a PER-MERCHANT GTIN matrix for "true duplicates" (Catalog identity),
 *   without touching/overwriting your inventory collection.
 *
 *   True duplicate GTIN = same GTIN appears on >1 ACTIVE, visible, not-deleted
 *   ITEM_VARIATION within the SAME merchant's Square catalog.
 *
 *   ✅ GTIN canonicalization (via lib/gtin.canonicalGtin):
 *     - 8-digit stays 8-digit
 *     - 12/13/14 stays unchanged
 *     - If longer than 8 and prefix is ALL zeros, treat as zero-padded 8-digit → last 8
 *       (e.g. 000002785123 -> 02785123)
 *     - Otherwise unchanged
 *
 * WRITES (Firestore ONLY)
 *   merchants/{merchantId}/gtin_matrix/{gtin}
 *     {
 *       gtin,
 *       merchant_id,
 *       canonical_name,
 *       variation_count,
 *       variations: {
 *         "<variationId>": {
 *           variation_id,
 *           item_id,
 *           item_name,
 *           sku,
 *           price,
 *           currency,
 *           visibility,
 *           is_deleted
 *         }
 *       },
 *       updated_at
 *     }
 *
 * DOES NOT
 *   - Create or modify Square catalog
 *   - Read/write/overwrite merchants/{merchantId}/inventory or inventory
 *
 * INPUTS / TOKENS
 *   - If env SQUARE_ACCESS_TOKEN is set => used for the run (single merchant recommended)
 *   - Otherwise reads Firestore: merchants/{merchantId}.square_access_token (or access_token)
 *
 * RUN
 *   # all merchants (from Firestore merchants collection)
 *   node scripts/buildGtinMatrix.js
 *
 *   # one merchant
 *   node scripts/buildGtinMatrix.js --merchantId=ML1AH5AM3K151
 *
 *   # dry run (no writes)
 *   DRY_RUN=1 node scripts/buildGtinMatrix.js
 *
 * ENV
 *   SQUARE_ENV=production | sandbox         (optional; overrides merchant doc env)
 *   DRY_RUN=1                               (optional)
 *   BATCH_SIZE=400                          (optional, <=450)
 *   TARGET_MERCHANT_ID=<id>                 (optional)
 *   MERCHANT_IDS=ML1...,MLRE...,MLTW...     (optional; overrides listAllMerchantIds)
 *
 * NOTES
 *   - If a merchant has no token or token is invalid, it will log an error and continue.
 *   - If GTINs are not populated in Square catalog, output will be empty for that merchant.
 * ============================================================================
 */
require("../lib/loadEnv"); // adjust relative path

const firestore = require("../lib/firestore");
const { createSquareClient } = require("../lib/square"); 
const { canonicalGtin } = require("../lib/gtin");

const DEFAULT_WRITE_BATCH = 400;

// ------------------------
// small utils
// ------------------------
function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    out[k] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function normalizeEnv(raw) {
  const s = String(raw || "").toLowerCase().trim();
  if (s.includes("sand")) return "sandbox";
  if (s.includes("prod")) return "production";
  // default safety: production if not explicitly sandbox
  return s === "sandbox" ? "sandbox" : "production";
}

function moneyToNumber(money) {
  if (!money || typeof money.amount !== "number") return null;
  return money.amount / 100;
}

function isDeleted(obj) {
  return !!(obj?.isDeleted || obj?.is_deleted);
}

function getItemVisibility(itemObj) {
  return itemObj?.itemData?.visibility || itemObj?.item_data?.visibility || null;
}

function getItemName(itemObj) {
  return itemObj?.itemData?.name || itemObj?.item_data?.name || null;
}

function pickVariationFields(variationObj) {
  const vd = variationObj?.itemVariationData || variationObj?.item_variation_data || {};
  const priceMoney = vd.priceMoney || vd.price_money || null;

  return {
    itemId: vd.itemId || vd.item_id || null,
    sku: vd.sku || null,
    // Square stores UPC on variation; you store as GTIN.
    gtinRaw: vd.upc || vd.gtin || null,
    price: moneyToNumber(priceMoney),
    currency: priceMoney?.currency || null,
    state: vd.state || variationObj?.state || null,
  };
}

function isSellableActive(variationObj, parentItemObj) {
  if (!parentItemObj) return false;
  if (isDeleted(variationObj)) return false;
  if (isDeleted(parentItemObj)) return false;

  const visibility = String(getItemVisibility(parentItemObj) || "").toUpperCase();
  if (visibility === "HIDDEN") return false;

  const vState = String(
    variationObj?.state ||
      variationObj?.itemVariationData?.state ||
      variationObj?.item_variation_data?.state ||
      ""
  ).toUpperCase();

  if (vState && vState !== "ACTIVE") return false;
  return true;
}

function squareErrInfo(e) {
  const status = e?.statusCode || e?.status || e?.response?.status || null;
  const errors =
    e?.result?.errors ||
    e?.errors ||
    e?.response?.body?.errors ||
    e?.response?.data?.errors ||
    null;

  let msg = e?.message || String(e);
  if (errors && Array.isArray(errors) && errors.length) {
    const first = errors[0];
    msg = `${msg} | ${first.code || "ERR"}: ${first.detail || ""}`.trim();
  }

  return { status, errors, msg };
}

// ------------------------
// merchant listing + tokens
// ------------------------
async function listAllMerchantIds() {
  // Optional env list override
  if (process.env.MERCHANT_IDS) {
    return String(process.env.MERCHANT_IDS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const snap = await firestore.collection("merchants").get();
  return snap.docs.map((d) => d.id);
}

async function getMerchantAuth(merchantId) {
  // env override token is allowed (mostly for single merchant debug)
  if (process.env.SQUARE_ACCESS_TOKEN) {
    const env = normalizeEnv(process.env.SQUARE_ENV || "production");
    return { token: process.env.SQUARE_ACCESS_TOKEN, env };
  }

  const snap = await firestore.collection("merchants").doc(merchantId).get();
  if (!snap.exists) throw new Error(`No merchants/${merchantId} doc found`);

  const d = snap.data() || {};
  const token = d.square_access_token || d.access_token || null;
  if (!token) throw new Error(`merchants/${merchantId} missing square_access_token (or access_token)`);

  // env priority: ENV override > merchant doc > default production
  const env =
    normalizeEnv(process.env.SQUARE_ENV || "") ||
    normalizeEnv(d.env || "") ||
    "production";

  // normalizeEnv default returns production unless explicit sandbox
  return { token, env: process.env.SQUARE_ENV ? normalizeEnv(process.env.SQUARE_ENV) : normalizeEnv(d.env || "production") };
}

async function sanityCheck(squareClient, merchantId, env) {
  try {
    const r = await squareClient.locationsApi.listLocations();
    const n = r?.result?.locations?.length || 0;
    console.log(`✅ [auth-ok] merchant=${merchantId} env=${env} locations=${n}`);
  } catch (e) {
    const info = squareErrInfo(e);
    console.error(`❌ [auth-fail] merchant=${merchantId} env=${env} status=${info.status ?? "?"}`);
    if (info.errors) console.error(JSON.stringify(info.errors, null, 2));
    throw e;
  }
}

// ------------------------
// square catalog fetch
// ------------------------
async function fetchAllItemVariations(squareClient) {
  const catalogApi = squareClient.catalogApi;

  let cursor = undefined;
  const variations = [];
  const relatedById = new Map();

  let page = 0;

  do {
    const body = {
      objectTypes: ["ITEM_VARIATION"],
      includeRelatedObjects: true,
      cursor,
      // Optional: keep it consistent. Square defaults to false for deleted.
      // includeDeletedObjects: false,
    };

    const resp = await catalogApi.searchCatalogObjects(body);
    const result = resp?.result || resp || {};

    const objs = result.objects || [];
    const related = result.relatedObjects || [];

    for (const r of related) relatedById.set(r.id, r);
    for (const o of objs) variations.push(o);

    cursor = result.cursor || undefined;
    page++;

    if (page % 5 === 0) {
      console.log(`   catalog pages=${page} variations_so_far=${variations.length} cursor=${cursor ? "yes" : "no"}`);
    }
  } while (cursor);

  return { variations, relatedById };
}

// ------------------------
// per-merchant build
// ------------------------
async function buildForOneMerchant(merchantId, { dryRun, writeBatchSize }) {
  const { token, env } = await getMerchantAuth(merchantId);

  // ✅ DO NOT log the token
  console.log(`[merchant auth] merchant=${merchantId} env=${env} token_present=${!!token}`);

  const squareClient = createSquareClient(token, env);

  console.log(`\n📦 Merchant ${merchantId}: sanity check + fetching catalog variations...`);
  await sanityCheck(squareClient, merchantId, env);

  const { variations, relatedById } = await fetchAllItemVariations(squareClient);

  // group by canonical gtin
  const gtinGroups = new Map(); // gtin -> rec[]

  for (const v of variations) {
    const { itemId, sku, gtinRaw, price, currency } = pickVariationFields(v);

    const gtin = canonicalGtin(gtinRaw);
    if (!gtin) continue;

    const parentItem = itemId ? relatedById.get(itemId) : null;
    if (!isSellableActive(v, parentItem)) continue;

    const itemName = getItemName(parentItem) || "(Unnamed Item)";
    const visibility = getItemVisibility(parentItem) || null;

    const rec = {
      variation_id: v.id,
      item_id: itemId,
      item_name: itemName,
      sku: sku || null,
      price: Number.isFinite(price) ? price : null,
      currency: currency || null,
      visibility,
      is_deleted: isDeleted(v) || isDeleted(parentItem),
    };

    if (!gtinGroups.has(gtin)) gtinGroups.set(gtin, []);
    gtinGroups.get(gtin).push(rec);
  }

  const dupCount = Array.from(gtinGroups.values()).filter((a) => a.length > 1).length;
  console.log(`✅ Merchant ${merchantId}: gtins=${gtinGroups.size}, trueDupes=${dupCount}`);

  if (dryRun) return { gtins: gtinGroups.size, duplicates: dupCount, written: 0 };

  const gtinCol = firestore.collection("merchants").doc(merchantId).collection("gtin_matrix");
  const nowIso = new Date().toISOString();

  let batch = firestore.batch();
  let ops = 0;
  let written = 0;

  async function commit() {
    if (!ops) return;
    await batch.commit();
    batch = firestore.batch();
    ops = 0;
  }

  for (const [gtin, recs] of gtinGroups.entries()) {
    const canonicalName =
      recs
        .map((r) => r.item_name || "")
        .filter(Boolean)
        .sort((a, b) => a.length - b.length)[0] || null;

    const variationsMap = {};
    for (const r of recs) variationsMap[r.variation_id] = r;

    batch.set(
      gtinCol.doc(gtin),
      {
        gtin,
        merchant_id: merchantId,
        canonical_name: canonicalName,
        variation_count: recs.length,
        variations: variationsMap,
        updated_at: nowIso,
      },
      { merge: true }
    );

    ops++;
    written++;

    if (ops >= writeBatchSize) await commit();
  }

  await commit();
  return { gtins: gtinGroups.size, duplicates: dupCount, written };
}

// ------------------------
// main
// ------------------------
async function runBuildGtinMatrix(options = {}) {
  const args = { ...parseArgs(process.argv), ...options };

  const merchantIdArg = args.merchantId || process.env.TARGET_MERCHANT_ID || null;
  const dryRun = !!(args.dryRun || process.env.DRY_RUN);
  const writeBatchSize = Math.min(
    Number(args.writeBatch || process.env.BATCH_SIZE) || DEFAULT_WRITE_BATCH,
    450
  );

  const merchantIds = merchantIdArg ? [merchantIdArg] : await listAllMerchantIds();

  console.log(`\n🔧 buildGtinMatrix (Catalog true duplicates)`);
  console.log(`   merchants=${merchantIds.length} dryRun=${dryRun} writeBatchSize=${writeBatchSize}`);
  console.log(`   SQUARE_ENV override=${process.env.SQUARE_ENV ? normalizeEnv(process.env.SQUARE_ENV) : "(none)"}\n`);

  let totalGtins = 0;
  let totalDupes = 0;
  let totalWritten = 0;
  let failed = 0;

  for (const mid of merchantIds) {
    try {
      const r = await buildForOneMerchant(mid, { dryRun, writeBatchSize });
      totalGtins += r.gtins;
      totalDupes += r.duplicates;
      totalWritten += r.written;
    } catch (e) {
      failed++;
      const info = squareErrInfo(e);
      console.error(`❌ Merchant ${mid} failed: ${info.msg}`);
      if (info.status) console.error(`   status=${info.status}`);
      // if Square errors exist, print once (compact)
      if (info.errors) {
        try {
          console.error("   square_errors:", JSON.stringify(info.errors));
        } catch (_) {}
      }
      continue;
    }
  }

  console.log(`\n✅ Done.`);
  console.log(`   total merchants: ${merchantIds.length}`);
  console.log(`   failed merchants: ${failed}`);
  console.log(`   total gtin docs: ${totalGtins}`);
  console.log(`   total true dupes: ${totalDupes}`);
  console.log(`   total written: ${dryRun ? 0 : totalWritten}\n`);

  console.log("Dashboard query (per merchant):");
  console.log("  merchants/{merchantId}/gtin_matrix  WHERE variation_count > 1\n");

  if (failed > 0) {
    console.log("If failures are 401 in production:");
    console.log("  - token is invalid/revoked, or");
    console.log("  - token is sandbox but SQUARE_ENV=production, or");
    console.log("  - merchant doc env is wrong, or");
    console.log("  - you need to re-auth that merchant (OAuth) to refresh token.\n");
  }
}

module.exports = {
  runBuildGtinMatrix,
  buildGtinMatrix: runBuildGtinMatrix,
};

if (require.main === module) {
  runBuildGtinMatrix().catch((e) => {
    const info = squareErrInfo(e);
    console.error("Fatal build error:", info.msg);
    process.exit(1);
  });
}
