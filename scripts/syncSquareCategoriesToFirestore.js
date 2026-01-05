#!/usr/bin/env node
/**
 * scripts/syncSquareCategoriesToFirestore.js
 * ------------------------------------------------------------
 * PURPOSE
 *   Pull Square Catalog Categories for each merchant using your
 *   existing lib/square.js client factory, then store them in Firestore:
 *
 *   Collection: square_categories
 *   Doc ID: <merchantId>__<categoryId>
 *
 *   ✅ Added: optional cleanup before syncing (delete existing docs for merchant)
 *
 * USAGE
 *   node scripts/syncSquareCategoriesToFirestore.js
 *   node scripts/syncSquareCategoriesToFirestore.js --merchant MLRE062EYSN7E
 *   node scripts/syncSquareCategoriesToFirestore.js --dry-run
 *
 *   ✅ Cleanup:
 *   node scripts/syncSquareCategoriesToFirestore.js --clean
 *   node scripts/syncSquareCategoriesToFirestore.js --merchant MLRE062EYSN7E --clean
 *
 * REQUIREMENTS
 *   - Your lib/square.js exports makeCreateSquareClientForMerchant({ firestore })
 *   - Firestore contains merchants/{merchantId} whatever your lib reads
 * ------------------------------------------------------------
 */

require("../lib/loadEnv");

const firestore = require("../lib/firestore");
const { FieldPath } = require("@google-cloud/firestore");

// ✅ Use YOUR library
const { makeCreateSquareClientForMerchant } = require("../lib/square");
const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

// -------------------------
// CLI args
// -------------------------
const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] || null;
}

const TARGET_MERCHANT_ID = argValue("--merchant") || argValue("-m");
const DRY_RUN = argv.includes("--dry-run") || argv.includes("--dryrun");
const CLEAN_BEFORE_SYNC = argv.includes("--clean") || argv.includes("--cleanup");

// -------------------------
// Helpers
// -------------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Delete all docs in square_categories for a specific merchant.
 * Assumes docId format: <merchantId>__<categoryId>
 */
async function deleteSquareCategoriesForMerchant({ firestore, merchantId }) {
  const col = firestore.collection("square_categories");

  const start = `${merchantId}__`;
  const end = `${merchantId}__\uf8ff`;

  let deleted = 0;

  while (true) {
    const snap = await col
      .orderBy(FieldPath.documentId())
      .startAt(start)
      .endAt(end)
      .limit(450) // keep margin under 500 ops/batch
      .get();

    if (snap.empty) break;

    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    deleted += snap.size;

    if (snap.size < 450) break;
  }

  return deleted;
}

/**
 * Lists ALL CATEGORY objects from Square Catalog for a merchant.
 * Works with square/legacy client: client.catalogApi.listCatalog(cursor, types)
 */
async function listAllSquareCategories(squareClient) {
  const catalogApi = squareClient.catalogApi;

  let cursor = undefined;
  const objects = [];

  while (true) {
    const resp = await catalogApi.listCatalog(cursor, "CATEGORY");
    const batch = resp?.result?.objects || [];
    objects.push(...batch);

    cursor = resp?.result?.cursor;
    if (!cursor) break;
  }

  return objects;
}

// -------------------------
// Main
// -------------------------
(async function main() {
  console.log("🔥 Using Firestore database:", process.env.APP_ENV || process.env.NODE_ENV || "dev");
  console.log("🔧 SQUARE_ENV:", process.env.SQUARE_ENV || "sandbox");
  console.log("🧪 DRY_RUN:", DRY_RUN);
  console.log("🧹 CLEAN_BEFORE_SYNC:", CLEAN_BEFORE_SYNC);
  if (TARGET_MERCHANT_ID) console.log("🎯 TARGET_MERCHANT_ID:", TARGET_MERCHANT_ID);

  // Determine merchants
  let merchantIds = [];
  if (TARGET_MERCHANT_ID) {
    merchantIds = [TARGET_MERCHANT_ID];
  } else {
    const merchantsSnap = await firestore.collection("merchants").get();
    merchantIds = merchantsSnap.docs.map((d) => d.id);
  }

  if (!merchantIds.length) {
    console.log("No merchants found.");
    process.exit(0);
  }

  let totalWritten = 0;
  const results = [];

  for (const merchantId of merchantIds) {
    console.log("\n==============================");
    console.log("🏪 Merchant:", merchantId);

    // ✅ Cleanup before sync
    if (CLEAN_BEFORE_SYNC) {
      if (DRY_RUN) {
        console.log("🧪 DRY_RUN: would cleanup existing Firestore square_categories docs for merchant");
      } else {
        console.log("🧹 Cleaning existing Firestore square_categories docs for merchant...");
        const deleted = await deleteSquareCategoriesForMerchant({ firestore, merchantId });
        console.log("🗑️  Deleted:", deleted);
      }
    }

    let squareClient;
    try {
      // ✅ This uses your existing logic (token lookup, env, etc.)
      squareClient = await createSquareClientForMerchant({ merchantId });
      if (!squareClient) throw new Error("createSquareClientForMerchant returned null/undefined");
    } catch (e) {
      console.log("⚠️  Skipping: could not create Square client for merchant:", e.message || e);
      results.push({ merchantId, ok: false, error: e.message || "Square client create failed" });
      continue;
    }

    let cats = [];
    try {
      cats = await listAllSquareCategories(squareClient);
    } catch (e) {
      console.error("❌ Failed to list categories from Square:", e.message || e);
      results.push({ merchantId, ok: false, error: e.message || "Square listCatalog failed" });
      continue;
    }

    console.log("📦 Categories from Square:", cats.length);

    // Transform into Firestore writes
    const fetchedAt = nowIso();
    const writes = cats
      .map((obj) => {
        const categoryId = obj?.id || null;
        const categoryName = (obj?.categoryData?.name || "").trim();
        const version = obj?.version ?? null;
        const isDeleted = !!obj?.isDeleted;

        if (!categoryId || !categoryName) return null;

        const docId = `${merchantId}__${categoryId}`;
        return {
          docId,
          data: {
            merchant_id: merchantId,
            category_id: categoryId,
            category_name: categoryName,
            version,
            is_deleted: isDeleted,
            fetched_at: fetchedAt,
            updated_at: fetchedAt,
            // Keep raw for debugging; remove if you want smaller docs:
            square_raw: obj,
          },
        };
      })
      .filter(Boolean);

    console.log("📝 Firestore docs to upsert:", writes.length);

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN: not writing.");
      results.push({ merchantId, ok: true, categories: cats.length, written: 0, dryRun: true });
      continue;
    }

    // Batch writes (Firestore max 500 ops per batch; keep margin)
    const batches = chunk(writes, 450);

    let written = 0;
    for (const b of batches) {
      const batch = firestore.batch();
      for (const w of b) {
        const ref = firestore.collection("square_categories").doc(w.docId);
        batch.set(ref, w.data, { merge: true });
      }
      await batch.commit();
      written += b.length;
    }

    totalWritten += written;

    // Optional meta
    await firestore.collection("square_sync_meta").doc("categories").set(
      {
        last_synced_at: fetchedAt,
        last_synced_merchant_id: merchantId,
        last_synced_by: "script",
        clean_before_sync: CLEAN_BEFORE_SYNC,
      },
      { merge: true }
    );

    console.log("✅ Written:", written);
    results.push({ merchantId, ok: true, categories: cats.length, written });
  }

  console.log("\n==============================");
  console.log("DONE ✅ totalWritten:", totalWritten);
  console.log("Results:", results);

  process.exit(0);
})().catch((err) => {
  console.error("FATAL ❌", err);
  process.exit(1);
});
