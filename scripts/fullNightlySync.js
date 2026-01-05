// scripts/fullNightlySync.js
/**
 * Full Nightly Sync Runner
 * ============================================================
 * WHAT IT DOES
 *   1) syncAllMerchants()  -> Pull from Square → Firestore
 *   2) buildGtinInventoryMatrixConsolidated() -> Rebuild gtin_matrix + location_index
 *   3) Update meta/sync_status -> last_full_sync_at (and which steps ran)
 *
 * HOW TO RUN (examples)
 *   # Run everything (default)
 *   node scripts/fullNightlySync.js
 *
 *   # Only rebuild matrix (skip Square sync)
 *   RUN_SYNC=0 RUN_BUILD=1 node scripts/fullNightlySync.js
 *
 *   # Only Square sync (skip matrix rebuild)
 *   RUN_SYNC=1 RUN_BUILD=0 node scripts/fullNightlySync.js
 *
 *   # Skip meta update too
 *   RUN_META=0 node scripts/fullNightlySync.js
 *
 *   # Run nothing but still exit cleanly (mostly for testing)
 *   RUN_SYNC=0 RUN_BUILD=0 RUN_META=0 node scripts/fullNightlySync.js
 *
 * ENV VARS
 *   RUN_SYNC   = 1/0   (default 1)  -> run syncAllMerchants
 *   RUN_BUILD  = 1/0   (default 1)  -> run buildGtinInventoryMatrixConsolidated
 *   RUN_META   = 1/0   (default 1)  -> update Firestore meta doc
 */

require("../lib/loadEnv"); // adjust relative path

const { syncAllMerchants } = require("../lib/inventorySync");
const { buildGtinInventoryMatrixConsolidated } = require("./buildGtinInventoryMatrixConsolidated");

function boolEnv(name, defaultVal = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return defaultVal;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(v)) return false;
  return defaultVal;
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

(async () => {
  try {
    const RUN_SYNC = boolEnv("RUN_SYNC", true);
    const RUN_BUILD = boolEnv("RUN_BUILD", true);
    const RUN_META = boolEnv("RUN_META", true);

    console.log("🚀 Starting full nightly sync...", { RUN_SYNC, RUN_BUILD, RUN_META });
    const start = Date.now();

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

    // 3) Update “last sync” meta
    if (RUN_META) {
      const firestore = require("../lib/firestore");
      await firestore
        .collection("meta")
        .doc("sync_status")
        .set(
          {
            last_full_sync_at: new Date().toISOString(),
            last_full_sync_steps: { RUN_SYNC, RUN_BUILD, RUN_META },
          },
          { merge: true }
        );
      console.log("✅ Updated meta/sync_status");
    } else {
      console.log("⏭️  Skipping meta update (RUN_META=0)");
    }

    console.log("🎉 Full nightly sync completed in", ((Date.now() - start) / 1000).toFixed(1), "sec");
    process.exit(0);
  } catch (err) {
    console.error("❌ Full nightly sync FAILED:", err);
    process.exit(1);
  }
})();
