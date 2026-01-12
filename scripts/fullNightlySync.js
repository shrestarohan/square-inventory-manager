// scripts/fullNightlySync.js
/**
 * Full Nightly Sync Runner
 * ============================================================
 * WHAT IT DOES
 *   0) (optional) Clean derived collections
 *   1) syncAllMerchants()  -> Pull from Square → Firestore
 *   2) buildGtinInventoryMatrixConsolidated() -> Rebuild gtin_matrix + location_index
 *   3) Update meta/sync_status -> last_full_sync_at (and which steps ran)
 *
 * HOW TO RUN (examples)
 *   # Run everything (default)
 *   node scripts/fullNightlySync.js
 *
 *   # Clean + run everything (requires confirm)
 *   RUN_CLEAN=1 CLEAN_CONFIRM=DELETE node scripts/fullNightlySync.js
 *
 *   # Clean only derived collections then rebuild
 *   RUN_CLEAN=1 CLEAN_CONFIRM=DELETE RUN_SYNC=0 RUN_BUILD=1 node scripts/fullNightlySync.js
 *
 * ENV VARS
 *   RUN_CLEAN  = 1/0   (default 0)  -> delete derived collections first
 *   CLEAN_CONFIRM=DELETE            -> required when RUN_CLEAN=1 (safety)
 *   CLEAN_COLLECTIONS=...           -> comma-separated list (default: gtin_inventory_matrix,location_index)
 *   CLEAN_LIMIT = N (default 0)     -> max docs per collection (0 = no limit)
 *   CLEAN_BATCH = N (default 400)   -> batch size for deletes
 *
 *   RUN_SYNC   = 1/0   (default 1)  -> run syncAllMerchants
 *   RUN_BUILD  = 1/0   (default 1)  -> run buildGtinInventoryMatrixConsolidated
 *   RUN_META   = 1/0   (default 1)  -> update Firestore meta doc
 */

require("../lib/loadEnv"); // adjust relative path

const { syncAllMerchants } = require("../lib/inventorySync");
const { buildGtinInventoryMatrixConsolidated } = require("./buildGtinInventoryMatrixConsolidated");
const { rebuildMasterInventory } = require("../lib/rebuildMasterInventory");
const RUN_MASTER = boolEnv("RUN_MASTER", false);
const MASTER_DRY_RUN = boolEnv("MASTER_DRY_RUN", false);
const MASTER_AFTER_SYNC = boolEnv("MASTER_AFTER_SYNC", true);

function boolEnv(name, defaultVal = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return defaultVal;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(v)) return false;
  return defaultVal;
}

function intEnv(name, defaultVal) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return defaultVal;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : defaultVal;
}

function listEnv(name, defaultVal = []) {
  const raw = (process.env[name] || "").toString().trim();
  if (!raw) return defaultVal;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runBuilder(mod) {
  // supports:
  // - buildGtinInventoryMatrixConsolidated()  (function export)
  // - buildGtinInventoryMatrixConsolidated.main() (object with main)
  if (typeof mod?.main === "function") return mod.main();
  if (typeof mod === "function") return mod();
  throw new Error(
    "buildGtinInventoryMatrixConsolidated export is not callable (expected function or { main })."
  );
}

// ------------------------------
// Delete collection helper
// ------------------------------
async function deleteCollection({ firestore, collectionName, batchSize = 400, limit = 0 }) {
  const colRef = firestore.collection(collectionName);

  let deleted = 0;
  let page = 0;

  while (true) {
    // Pull a page of doc refs
    let q = colRef.orderBy("__name__").limit(batchSize);
    if (limit > 0) {
      const remaining = limit - deleted;
      if (remaining <= 0) break;
      q = colRef.orderBy("__name__").limit(Math.min(batchSize, remaining));
    }

    const snap = await q.get();
    if (snap.empty) break;

    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    deleted += snap.size;
    page += 1;

    if (page % 10 === 0) {
      console.log(`   🧹 ${collectionName}: deleted ${deleted} docs so far...`);
    }
  }

  return deleted;
}

(async () => {
  try {
    const RUN_CLEAN = boolEnv("RUN_CLEAN", false);
    const RUN_SYNC = boolEnv("RUN_SYNC", true);
    const RUN_BUILD = boolEnv("RUN_BUILD", true);
    const RUN_META = boolEnv("RUN_META", true);

    const CLEAN_CONFIRM = (process.env.CLEAN_CONFIRM || "").toString().trim();
    const CLEAN_COLLECTIONS = listEnv("CLEAN_COLLECTIONS", [
      "gtin_inventory_matrix",
      "location_index",
    ]);
    const CLEAN_LIMIT = intEnv("CLEAN_LIMIT", 0);
    const CLEAN_BATCH = intEnv("CLEAN_BATCH", 400);

    console.log("🚀 Starting full nightly sync...", {
      RUN_CLEAN,
      RUN_SYNC,
      RUN_BUILD,
      RUN_META,
      CLEAN_COLLECTIONS,
      CLEAN_LIMIT,
      CLEAN_BATCH,
    });

    const start = Date.now();

    // 0) Optional: clean derived collections
    if (RUN_CLEAN) {
      if (CLEAN_CONFIRM !== "DELETE") {
        throw new Error(
          `RUN_CLEAN=1 requires CLEAN_CONFIRM=DELETE (got "${CLEAN_CONFIRM || "(empty)"}")`
        );
      }
      const firestore = require("../lib/firestore");

      console.log("🧹 Cleaning collections BEFORE running sync/build...");
      const t0 = Date.now();

      const results = {};
      for (const col of CLEAN_COLLECTIONS) {
        const c0 = Date.now();
        console.log(` - Deleting collection: ${col}`);
        const count = await deleteCollection({
          firestore,
          collectionName: col,
          batchSize: CLEAN_BATCH,
          limit: CLEAN_LIMIT,
        });
        results[col] = count;
        console.log(`   ✅ ${col}: deleted ${count} docs in ${((Date.now() - c0) / 1000).toFixed(1)}s`);
      }

      console.log(
        "✅ Clean step done in",
        ((Date.now() - t0) / 1000).toFixed(1),
        "sec",
        results
      );
    } else {
      console.log("⏭️  Skipping clean step (RUN_CLEAN=0)");
    }

    // 1) Pull from Square → Firestore
    if (RUN_SYNC) {
      const t0 = Date.now();
      await syncAllMerchants();
      console.log(
        "✅ syncAllMerchants done in",
        ((Date.now() - t0) / 1000).toFixed(1),
        "sec"
      );
    } else {
      console.log("⏭️  Skipping syncAllMerchants (RUN_SYNC=0)");
    }

    // 2) Rebuild gtin_matrix + location_index
    if (RUN_BUILD) {
      const t0 = Date.now();
      await runBuilder(buildGtinInventoryMatrixConsolidated);
      console.log(
        "✅ buildGtinInventoryMatrixConsolidated done in",
        ((Date.now() - t0) / 1000).toFixed(1),
        "sec"
      );
    } else {
      console.log("⏭️  Skipping buildGtinInventoryMatrixConsolidated (RUN_BUILD=0)");
    }

    // 3) Optional: rebuild master top-level inventory
    if (RUN_MASTER) {
      if (MASTER_AFTER_SYNC && !RUN_SYNC) {
        console.log("⏭️  Skipping master rebuild (MASTER_AFTER_SYNC=1 but RUN_SYNC=0)");
      } else {
        const t0 = Date.now();
        const result = await rebuildMasterInventory({ dryRun: MASTER_DRY_RUN });
        console.log(
          "✅ rebuildMasterInventory done in",
          ((Date.now() - t0) / 1000).toFixed(1),
          "sec",
          result
        );
      }
    } else {
      console.log("⏭️  Skipping rebuildMasterInventory (RUN_MASTER=0)");
    }

    // 4) Update “last sync” meta
    if (RUN_META) {
      const firestore = require("../lib/firestore");
      await firestore
        .collection("meta")
        .doc("sync_status")
        .set(
          {
            last_full_sync_at: new Date().toISOString(),
            last_full_sync_steps: { RUN_CLEAN, RUN_SYNC, RUN_MASTER, RUN_BUILD, RUN_META },
            last_full_sync_clean: RUN_CLEAN
              ? {
                  collections: CLEAN_COLLECTIONS,
                  limit: CLEAN_LIMIT,
                  batch: CLEAN_BATCH,
                }
              : null,
          },
          { merge: true }
        );
      console.log("✅ Updated meta/sync_status");
    } else {
      console.log("⏭️  Skipping meta update (RUN_META=0)");
    }

    console.log(
      "🎉 Full nightly sync completed in",
      ((Date.now() - start) / 1000).toFixed(1),
      "sec"
    );
    process.exit(0);
  } catch (err) {
    console.error("❌ Full nightly sync FAILED:", err);
    process.exit(1);
  }
})();
