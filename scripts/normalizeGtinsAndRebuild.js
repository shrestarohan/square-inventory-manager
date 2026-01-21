/**
 * scripts/normalizeGtinsAndRebuild.js
 * ============================================================
 * PURPOSE
 *   One-time maintenance tool to:
 *     A) Normalize (canonicalize) GTIN fields in Firestore inventory docs
 *     B) Clean (delete) derived GTIN matrix collections
 *     C) Optionally rebuild the consolidated matrix afterward
 *
 * OPTIONS (env)
 *   DRY_RUN=1                 -> do not write/delete, only log
 *   NORMALIZE_INVENTORY=1     -> canonicalize gtin in:
 *                                 - inventory (global)
 *                                 - merchants/{merchantId}/inventory
 *   CLEAN_DERIVED=1           -> delete:
 *                                 - gtin_inventory_matrix
 *                                 - location_index
 *   REBUILD=1                 -> run scripts/buildGtinInventoryMatrixConsolidated.js at end
 *
 *   TARGET_MERCHANT_ID=ML...  -> only normalize per-merchant inventory for this merchant
 *   READ_PAGE=1000            -> pagination page size for scans
 *   WRITE_BATCH=400           -> Firestore batch commit size (<=450 recommended)
 *
 * RUN EXAMPLES
 *   # 1) DRY RUN: see what would change
 *   DRY_RUN=1 NORMALIZE_INVENTORY=1 node scripts/normalizeGtinsAndRebuild.js
 *
 *   # 2) Normalize inventory GTINs (recommended fix)
 *   NORMALIZE_INVENTORY=1 node scripts/normalizeGtinsAndRebuild.js
 *
 *   # 3) Clean derived + rebuild consolidated matrix
 *   CLEAN_DERIVED=1 REBUILD=1 node scripts/normalizeGtinsAndRebuild.js
 *
 *   # 4) Full reset: normalize + clean derived + rebuild
 *   NORMALIZE_INVENTORY=1 CLEAN_DERIVED=1 REBUILD=1 node scripts/normalizeGtinsAndRebuild.js
 * ============================================================
 */

require("../lib/loadEnv"); // adjust relative path

const firestore = require("../lib/firestore");
const { canonicalGtin, normalizeDigits } = require("../lib/gtin");

const DEFAULT_READ_PAGE = 1000;
const DEFAULT_WRITE_BATCH = 400;

function parseBool(v) {
  if (!v) return false;
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "y";
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

async function listMerchantIds() {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map((d) => d.id);
}

// ------------------------------
// A) Normalize inventory GTINs
// ------------------------------
async function normalizeCollectionGtins({ colRef, dryRun, readPageSize, writeBatchSize, label, extraWhere }) {
  console.log(`\n🧹 Normalize GTINs: ${label}`);

  let totalScanned = 0;
  let totalChanged = 0;
  let totalWrites = 0;

  let batch = firestore.batch();
  let ops = 0;

  async function commit(force = false) {
    if (!ops) return;
    if (!force && ops < writeBatchSize) return;
    if (!dryRun) await batch.commit();
    batch = firestore.batch();
    ops = 0;
  }

  let lastDoc = null;

  while (true) {
    let q = colRef.orderBy("__name__").limit(readPageSize);
    if (extraWhere) q = extraWhere(q);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      totalScanned++;
      const d = doc.data() || {};

      const gtinRaw = d.gtin;
      const digits = normalizeDigits(gtinRaw);
      if (!digits) continue;

      const canon = canonicalGtin(digits);
      if (!canon) continue;

      if (String(gtinRaw) !== canon) {
        totalChanged++;

        // Update ONLY field (docId stays same)
        const patch = {
          gtin: canon,
          gtin_raw: String(gtinRaw ?? ""), // keep history (optional)
          gtin_normalized_at: new Date().toISOString(),
        };

        if (dryRun) {
          console.log(`  • ${doc.id}: "${gtinRaw}" -> "${canon}"`);
        } else {
          batch.update(doc.ref, patch);
          ops++;
          totalWrites++;
          if (ops >= writeBatchSize) await commit(true);
        }
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (totalScanned % 5000 === 0) {
      console.log(`   progress scanned=${totalScanned} changed=${totalChanged} writes=${totalWrites}`);
    }

    await commit(false);
  }

  await commit(true);

  console.log(`✅ ${label} done`);
  console.log(`   scanned=${totalScanned}`);
  console.log(`   changed=${totalChanged}`);
  console.log(`   writes=${dryRun ? 0 : totalWrites}`);
}

// ------------------------------
// B) Clean derived collections
// ------------------------------
async function deleteCollectionAllDocs({ colRef, dryRun, writeBatchSize, label }) {
  console.log(`\n🗑️ Clean derived: ${label}`);

  let totalDeleted = 0;

  while (true) {
    const snap = await colRef.orderBy("__name__").limit(writeBatchSize).get();
    if (snap.empty) break;

    if (dryRun) {
      totalDeleted += snap.size;
      console.log(`  • would delete ${snap.size} docs (total would=${totalDeleted})`);
    } else {
      const b = firestore.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
      totalDeleted += snap.size;
      console.log(`  • deleted ${snap.size} docs (total=${totalDeleted})`);
    }

    if (snap.size < writeBatchSize) break;
  }

  console.log(`✅ ${label} cleaned (${dryRun ? "dry-run" : "applied"}) total=${totalDeleted}`);
}

async function run() {
  const args = parseArgs(process.argv);

  const dryRun = parseBool(args.dryRun || process.env.DRY_RUN);
  const normalizeInventory = parseBool(args.normalizeInventory || process.env.NORMALIZE_INVENTORY);
  const cleanDerived = parseBool(args.cleanDerived || process.env.CLEAN_DERIVED);
  const rebuild = parseBool(args.rebuild || process.env.REBUILD);

  const readPageSize = Math.min(Number(args.readPage || process.env.READ_PAGE) || DEFAULT_READ_PAGE, 2000);
  const writeBatchSize = Math.min(Number(args.writeBatch || process.env.WRITE_BATCH) || DEFAULT_WRITE_BATCH, 450);

  const targetMerchant = args.merchantId || process.env.TARGET_MERCHANT_ID || null;

  console.log(`\n🔧 normalizeGtinsAndRebuild`);
  console.log(`   dryRun=${dryRun}`);
  console.log(`   normalizeInventory=${normalizeInventory}`);
  console.log(`   cleanDerived=${cleanDerived}`);
  console.log(`   rebuild=${rebuild}`);
  console.log(`   readPage=${readPageSize} writeBatch=${writeBatchSize}`);
  if (targetMerchant) console.log(`   TARGET_MERCHANT_ID=${targetMerchant}`);

  // A) Normalize raw inventory
  if (normalizeInventory) {
    // Global inventory
    await normalizeCollectionGtins({
      colRef: firestore.collection("inventory"),
      dryRun,
      readPageSize,
      writeBatchSize,
      label: "inventory (global)",
    });

    // Merchant inventories
    const merchantIds = targetMerchant ? [targetMerchant] : await listMerchantIds();
    for (const mid of merchantIds) {
      await normalizeCollectionGtins({
        colRef: firestore.collection("merchants").doc(mid).collection("inventory"),
        dryRun,
        readPageSize,
        writeBatchSize,
        label: `merchants/${mid}/inventory`,
      });
    }
  }

  // B) Clean derived
  if (cleanDerived) {
    await deleteCollectionAllDocs({
      colRef: firestore.collection("gtin_inventory_matrix"),
      dryRun,
      writeBatchSize,
      label: "gtin_inventory_matrix",
    });

    await deleteCollectionAllDocs({
      colRef: firestore.collection("location_index"),
      dryRun,
      writeBatchSize,
      label: "location_index",
    });
  }

  // C) Optional rebuild
  if (rebuild) {
    if (dryRun) {
      console.log("\n🧪 DRY_RUN=1 so skipping rebuild. If you want rebuild, run without DRY_RUN.");
    } else {
      console.log("\n🏗️ Rebuilding consolidated matrix...");
      // Require and run directly so it uses same env + Firestore instance
      const { run: runConsolidated } = require("./buildGtinInventoryMatrixConsolidated");
      await runConsolidated();
      console.log("✅ Rebuild done.");
    }
  }

  console.log("\n✅ All done.");
}

if (require.main === module) {
  run().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

module.exports = { run };
