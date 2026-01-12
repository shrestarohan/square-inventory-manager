/**
 * scripts/backfillSquareVariationUpc.js
 * ============================================================
 * PURPOSE
 *   Backfill Square Catalog ITEM_VARIATION UPC (GTIN) for items
 *   that were created/copied without upc set.
 *
 * WHY
 *   Your price mismatch dashboard + "update price" flows rely on GTIN.
 *   In Square Catalog API, GTIN/UPC lives on itemVariationData.upc.
 *
 * WHAT IT DOES
 *   - Scans Firestore inventory docs that have variation_id (Square variation ID)
 *   - Retrieves Square variation object
 *   - If itemVariationData.upc is missing/blank, sets it to the GTIN
 *   - Upserts the variation back into Square (with correct version)
 *
 * ENV
 *   APP_ENV, FIRESTORE_DATABASE_ID, GOOGLE_CLOUD_PROJECT, SQUARE_ENV
 *   SQUARE_ACCESS_TOKEN (optional global override)
 *
 * OPTIONS (env)
 *   DRY_RUN=1                 -> no writes
 *   MERCHANT_ID=ML...          -> only one merchant (default all)
 *   GTIN=0811538010405         -> only one gtin (optional)
 *   LIMIT=500                  -> max records processed (per run)
 *   READ_PAGE=500              -> firestore page size
 *   SLEEP_MS=120               -> throttle between Square calls
 *
 * RUN
 *   DRY_RUN=1 node scripts/backfillSquareVariationUpc.js
 *   DRY_RUN=0 MERCHANT_ID=ML... node scripts/backfillSquareVariationUpc.js
 */

require("../lib/loadEnv"); // loads dotenv locally (skips on Cloud Run)

const { Client, Environment } = require("square/legacy");

// If your project has a firestore helper, use it.
// Common pattern in your repo: lib/firestore.js exports { firestore } or the instance.
// Adjust if needed.
const firestore = require("../lib/firestore");
if (!firestore || typeof firestore.collection !== "function") {
  throw new Error("Firestore client not available (../lib/firestore did not export a Firestore instance).");
}

// Optional: if you have a canonicalizer, use it
let canonicalGtin = null;
try {
  ({ canonicalGtin } = require("../lib/gtin"));
} catch (_) {}

// -----------------------------
// Helpers
// -----------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function digitsOnly(s) {
  return String(s || "").replace(/\D+/g, "");
}

function normalizeUpcFromGtin(gtin) {
  const d = digitsOnly(gtin);
  if (!d) return null;

  // If you have a canonicalizer, prefer it
  if (typeof canonicalGtin === "function") {
    try {
      const c = canonicalGtin(d);
      // ensure digits only
      return digitsOnly(c);
    } catch (_) {
      return d;
    }
  }

  return d;
}

function isPresent(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && v.trim() === "") return false;
  return true;
}

function buildSquareClient(accessToken) {
  return new Client({
    environment: process.env.SQUARE_ENV === "production" ? Environment.Production : Environment.Sandbox,
    accessToken,
  });
}

async function getSquareAccessTokenForMerchant(merchantId) {
  const envToken = (process.env.SQUARE_ACCESS_TOKEN || "").toString().trim();
  if (envToken) return envToken;

  const snap = await firestore.collection("merchants").doc(merchantId).get();
  const data = snap.data() || {};
  const token = (data.square_access_token || data.squareAccessToken || "").toString().trim();
  return token || null;
}

function idempotencyKey(prefix, ...parts) {
  const raw = [prefix, ...parts].join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${prefix}-${h.toString(16)}`;
}

async function listMerchantIds() {
  // Use your existing index if you have it; otherwise read merchants collection.
  const q = await firestore.collection("merchants").get();
  return q.docs.map((d) => d.id);
}

// Firestore paging by document id (gtin) in inventory collection
async function pageInventoryDocs(invCol, startAfterDoc, limit) {
  let q = invCol.orderBy("__name__").limit(limit);
  if (startAfterDoc) q = q.startAfter(startAfterDoc);
  const snap = await q.get();
  return snap;
}

async function backfillMerchant({ merchantId, dryRun, gtinFilter, limitTotal, readPage, sleepMs }) {
  const token = await getSquareAccessTokenForMerchant(merchantId);
  if (!token) {
    console.log(`⚠️  ${merchantId}: no Square token found (skipping)`);
    return { merchantId, scanned: 0, needs: 0, updated: 0, skipped: 0, errors: 0 };
  }

  const squareClient = buildSquareClient(token);
  const catalogApi = squareClient.catalogApi;

  const invCol = firestore.collection("merchants").doc(merchantId).collection("inventory");

  let scanned = 0;
  let needs = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  console.log(`\n==============================`);
  console.log(`Merchant: ${merchantId}`);
  console.log(`DRY_RUN=${dryRun} GTIN=${gtinFilter || "(all)"} LIMIT=${limitTotal} READ_PAGE=${readPage}`);

  // If GTIN specified, directly load that doc (and fallback to query)
  if (gtinFilter) {
    const gtin = digitsOnly(gtinFilter);
    let doc = await invCol.doc(gtin).get();
    if (!doc.exists) {
      const q1 = await invCol.where("gtin", "==", gtin).limit(1).get();
      if (!q1.empty) doc = q1.docs[0];
    }
    if (!doc.exists) {
      console.log(`⚠️  GTIN ${gtin} not found in Firestore inventory for merchant ${merchantId}`);
      return { merchantId, scanned: 0, needs: 0, updated: 0, skipped: 0, errors: 0 };
    }

    const one = await processInventoryDoc({
      merchantId,
      doc,
      catalogApi,
      dryRun,
      sleepMs,
    });

    return {
      merchantId,
      scanned: one.scanned,
      needs: one.needs,
      updated: one.updated,
      skipped: one.skipped,
      errors: one.errors,
    };
  }

  // Otherwise scan paginated
  let last = null;

  while (true) {
    if (scanned >= limitTotal) break;

    const pageLimit = Math.min(readPage, limitTotal - scanned);
    const snap = await pageInventoryDocs(invCol, last, pageLimit);
    if (snap.empty) break;

    for (const doc of snap.docs) {
      if (scanned >= limitTotal) break;

      const r = await processInventoryDoc({
        merchantId,
        doc,
        catalogApi,
        dryRun,
        sleepMs,
      });

      scanned += r.scanned;
      needs += r.needs;
      updated += r.updated;
      skipped += r.skipped;
      errors += r.errors;

      last = doc;
    }
  }

  console.log(
    `✅ ${merchantId} done. scanned=${scanned} needs=${needs} updated=${updated} skipped=${skipped} errors=${errors}`
  );

  return { merchantId, scanned, needs, updated, skipped, errors };
}

async function processInventoryDoc({ merchantId, doc, catalogApi, dryRun, sleepMs }) {
  const data = doc.data() || {};
  const gtin = normalizeUpcFromGtin(data.gtin || doc.id);
  const variationId = (data.variation_id || data.square_variation_id || "").toString().trim();

  // We only can patch if we know variationId + gtin
  if (!gtin || !variationId) {
    return { scanned: 1, needs: 0, updated: 0, skipped: 1, errors: 0 };
  }

  // Retrieve Square variation
  try {
    const retrieve = await catalogApi.retrieveCatalogObject(variationId, false);
    const obj = retrieve?.result?.object;

    if (!obj || obj.type !== "ITEM_VARIATION") {
      console.log(`⚠️  ${merchantId} gtin=${gtin}: variation not found or not ITEM_VARIATION (${variationId})`);
      return { scanned: 1, needs: 0, updated: 0, skipped: 1, errors: 0 };
    }

    const curUpc = (obj.itemVariationData?.upc || "").toString().trim();
    if (isPresent(curUpc)) {
      // already has upc
      return { scanned: 1, needs: 0, updated: 0, skipped: 1, errors: 0 };
    }

    // Needs backfill
    console.log(`🧩 NEED UPC: ${merchantId} gtin=${gtin} variationId=${variationId} -> upc=${gtin}`);
    if (dryRun) {
      return { scanned: 1, needs: 1, updated: 0, skipped: 0, errors: 0 };
    }

    const patchObj = {
      id: obj.id,
      type: "ITEM_VARIATION",
      version: obj.version, // ✅ required to avoid version conflict
      itemVariationData: {
        ...(obj.itemVariationData || {}),
        upc: gtin,
      },
    };

    const upsertBody = {
      idempotencyKey: idempotencyKey("backfill-upc", merchantId, variationId, gtin),
      object: patchObj,
    };

    await catalogApi.upsertCatalogObject(upsertBody);
    await sleep(sleepMs);

    console.log(`✅ UPDATED UPC: ${merchantId} gtin=${gtin} variationId=${variationId}`);
    return { scanned: 1, needs: 1, updated: 1, skipped: 0, errors: 0 };
  } catch (err) {
    console.log(
      `❌ ERROR: ${merchantId} gtin=${gtin} variationId=${variationId} -> ${err?.message || String(err)}`
    );
    return { scanned: 1, needs: 0, updated: 0, skipped: 0, errors: 1 };
  }
}

// -----------------------------
// Main
// -----------------------------
(async function main() {
  const DRY_RUN = String(process.env.DRY_RUN || "1") === "1";
  const MERCHANT_ID = (process.env.MERCHANT_ID || "").toString().trim();
  const GTIN = (process.env.GTIN || "").toString().trim();

  const LIMIT = Number(process.env.LIMIT || 2000);
  const READ_PAGE = Number(process.env.READ_PAGE || 500);
  const SLEEP_MS = Number(process.env.SLEEP_MS || 120);

  if (!firestore) throw new Error("Firestore client not available. Check ../lib/firestore export.");

  const merchantIds = MERCHANT_ID ? [MERCHANT_ID] : await listMerchantIds();

  console.log("Backfill Square variation UPC");
  console.log("Merchants:", merchantIds.length);
  console.log(`DRY_RUN=${DRY_RUN} LIMIT=${LIMIT} READ_PAGE=${READ_PAGE} SLEEP_MS=${SLEEP_MS} GTIN=${GTIN || "(all)"}`);

  const totals = { scanned: 0, needs: 0, updated: 0, skipped: 0, errors: 0 };

  for (const mid of merchantIds) {
    const r = await backfillMerchant({
      merchantId: mid,
      dryRun: DRY_RUN,
      gtinFilter: GTIN || null,
      limitTotal: LIMIT,
      readPage: READ_PAGE,
      sleepMs: SLEEP_MS,
    });

    totals.scanned += r.scanned;
    totals.needs += r.needs;
    totals.updated += r.updated;
    totals.skipped += r.skipped;
    totals.errors += r.errors;
  }

  console.log("\n==============================");
  console.log("DONE");
  console.log(totals);
  process.exit(totals.errors ? 1 : 0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
