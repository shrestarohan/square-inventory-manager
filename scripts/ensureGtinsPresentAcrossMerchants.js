/**
 * scripts/ensureGtinsPresentAcrossMerchants.js
 * ============================================================
 * PURPOSE
 *   Ensure every unique GTIN seen in ANY merchant is present
 *   in ALL Square merchants (accounts).
 *
 * SOURCE OF TRUTH (fast):
 *   Firestore merchants/{merchantId}/inventory (gtin field)
 *
 * OPTIONAL FIX:
 *   Create placeholder Square catalog items for missing GTINs.
 *
 * MERCHANT SELECTION
 *   - If --merchants or MERCHANT_IDS is provided → use that list
 *   - Otherwise → loop through ALL merchants in Firestore collection "merchants"
 *
 * USAGE
 *   node scripts/ensureGtinsPresentAcrossMerchants.js
 *
 *   # Only report (default)
 *   DRY_RUN=1 node scripts/ensureGtinsPresentAcrossMerchants.js
 *
 *   # Create missing placeholder items in Square
 *   FIX=1 DRY_RUN=0 node scripts/ensureGtinsPresentAcrossMerchants.js
 *
 *   # Explicit merchants (comma separated)
 *   node scripts/ensureGtinsPresentAcrossMerchants.js --merchants=MLA,MLB,MLC
 *   MERCHANT_IDS=MLA,MLB,MLC node scripts/ensureGtinsPresentAcrossMerchants.js
 *
 * OPTIONAL
 *   LIMIT_GTINS=500           # only check first N union gtins
 *   READ_PAGE=2000            # read page size from FS
 * ============================================================
 */

require("../lib/loadEnv"); // adjust relative path

const firestore = require("../lib/firestore");
const { makeCreateSquareClientForMerchant } = require("../lib/square");

// ---------------- args/env ----------------
function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    out[k] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function normalizeGtin(g) {
  return String(g || "").trim();
}

async function listAllMerchantIds() {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map((d) => d.id);
}

async function listGtinsForMerchant(merchantId, readPageSize) {
  const invCol = firestore.collection("merchants").doc(merchantId).collection("inventory");
  const gtins = new Set();

  let last = null;
  let scanned = 0;

  while (true) {
    let q = invCol.orderBy("__name__").limit(readPageSize);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data() || {};
      const gtin = normalizeGtin(d.gtin);
      if (gtin) gtins.add(gtin);
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < readPageSize) break;
  }

  return { gtins, scanned };
}

async function writeReportToFirestore({ merchantIds, unionCount, missingByMerchant, created, failed }) {
  const report = {
    type: "gtin_presence_report",
    created_at: new Date().toISOString(),
    merchants: merchantIds,
    unionCount,
    missingCounts: Object.fromEntries(
      merchantIds.map(mid => [mid, (missingByMerchant.get(mid) || []).length])
    ),
    // store first 200 missing GTINs per merchant so doc doesn’t explode
    missingSamples: Object.fromEntries(
      merchantIds.map(mid => [mid, (missingByMerchant.get(mid) || []).slice(0, 200)])
    ),
    fixSummary: { created, failed },
  };

  // Keep latest report at a stable doc id (easy UI)
  await firestore.collection("reports").doc("gtin_presence_latest").set(report, { merge: true });

  // Also keep history
  await firestore.collection("reports").add(report);
}

// Create placeholder item in Square with UPC = GTIN
function buildPlaceholderUpsert(gtin) {
  const idempotencyKey = `ensure-gtin-${gtin}-${Date.now()}`;

  const itemTempId = `#ITEM_${gtin}`;
  const varTempId = `#VAR_${gtin}`;

  return {
    idempotencyKey,
    batches: [
      {
        objects: [
          {
            type: "ITEM",
            id: itemTempId,
            itemData: {
              name: `MISSING GTIN ${gtin}`,
              description: "Auto-created placeholder to keep GTINs consistent across merchants.",
              variations: [
                {
                  type: "ITEM_VARIATION",
                  id: varTempId,
                  itemVariationData: {
                    name: "Default",
                    sku: `GTIN-${gtin}`,
                    upc: gtin, // ✅ tie to GTIN in Square
                    pricingType: "FIXED_PRICING",
                    priceMoney: { amount: 0, currency: "USD" },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function createPlaceholderInSquare(square, merchantId, gtin) {
  const payload = buildPlaceholderUpsert(gtin);

  try {
    const resp = await square.catalogApi.batchUpsertCatalogObjects(payload);
    const errors = resp?.result?.errors;
    if (errors && errors.length) {
      return { ok: false, merchantId, gtin, errors };
    }
    return { ok: true, merchantId, gtin };
  } catch (e) {
    return {
      ok: false,
      merchantId,
      gtin,
      message: e?.message || String(e),
      statusCode: e?.statusCode,
      errors: e?.result?.errors || e?.errors || e?.body?.errors,
    };
  }
}

async function run() {
  const args = parseArgs(process.argv);

  // ✅ merchants: from args/env OR fallback to ALL merchants in Firestore
  let merchantIds = uniq(
    String(args.merchants || process.env.MERCHANT_IDS || "")
      .split(",")
      .map((s) => s.trim())
  );

  const merchantsSource = merchantIds.length ? "explicit" : "firestore(all)";
  if (!merchantIds.length) merchantIds = await listAllMerchantIds();

  if (!merchantIds.length) {
    console.error("❌ No merchants found in Firestore collection 'merchants'");
    process.exit(1);
  }

  const dryRun = !!(args.dryRun || process.env.DRY_RUN);
  const fix = !!(args.fix || process.env.FIX);
  const readPageSize = Math.min(Number(args.readPage || process.env.READ_PAGE) || 2000, 5000);

  const limitGtins = Number(args.limitGtins || process.env.LIMIT_GTINS) || null;

  console.log("\n🧾 ensureGtinsPresentAcrossMerchants");
  console.log("   merchantsSource:", merchantsSource);
  console.log("   merchants:", merchantIds);
  console.log("   dryRun:", dryRun, "fix:", fix, "readPage:", readPageSize, "limitGtins:", limitGtins || "none");

  if (fix && dryRun) {
    console.log("⚠️ FIX=1 but DRY_RUN=1 → will NOT create anything in Square.");
  }
  if (fix && !dryRun) {
    console.log("⚠️ FIX mode ON: will create placeholder Square items for missing GTINs.");
  }

  // Build sets per merchant
  const perMerchant = new Map(); // merchantId -> Set(gtin)
  const union = new Set();

  for (const mid of merchantIds) {
    const { gtins, scanned } = await listGtinsForMerchant(mid, readPageSize);
    perMerchant.set(mid, gtins);
    gtins.forEach((g) => union.add(g));
    console.log(`   ✅ merchant=${mid} scannedDocs=${scanned} uniqueGtins=${gtins.size}`);
  }

  const unionArr = Array.from(union);
  unionArr.sort();
  const unionLimited = limitGtins ? unionArr.slice(0, limitGtins) : unionArr;

  console.log(`\n📦 Union GTINs: ${unionArr.length}${limitGtins ? ` (checking first ${unionLimited.length})` : ""}`);

  // Missing map
  const missingByMerchant = new Map(); // merchantId -> [gtin...]
  for (const mid of merchantIds) missingByMerchant.set(mid, []);

  for (const gtin of unionLimited) {
    for (const mid of merchantIds) {
      if (!perMerchant.get(mid)?.has(gtin)) {
        missingByMerchant.get(mid).push(gtin);
      }
    }
  }

  // Print summary
  console.log("\n🔎 Missing GTIN counts:");
  for (const mid of merchantIds) {
    console.log(`   merchant=${mid} missing=${missingByMerchant.get(mid).length}`);
  }

  // Print top examples
  console.log("\n🧪 Sample missing (first 20 each):");
  for (const mid of merchantIds) {
    const arr = missingByMerchant.get(mid);
    console.log(`\n   merchant=${mid}`);
    console.log("   ", arr.slice(0, 20).join(", ") || "(none)");
  }

  if (!fix || dryRun) {
    console.log("\n✅ Report complete (no Square writes).");
    return;
  }

  // FIX: create placeholder items in Square for missing GTINs
  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  let totalCreated = 0;
  let totalFailed = 0;

  for (const mid of merchantIds) {
    const missing = missingByMerchant.get(mid) || [];
    if (!missing.length) continue;

    console.log(`\n🛠️  Creating placeholders in Square for merchant=${mid} missing=${missing.length}`);

    const square = await createSquareClientForMerchant({ merchantId: mid });

    // gentle on rate limits: sequential by default
    for (const gtin of missing) {
      const r = await createPlaceholderInSquare(square, mid, gtin);
      if (r.ok) {
        totalCreated++;
        if (totalCreated % 25 === 0) console.log(`   ...created ${totalCreated} so far`);
      } else {
        totalFailed++;
        console.error("   ❌ create failed", r);
      }
    }
  }

  await writeReportToFirestore({
    merchantIds,
    unionCount: unionArr.length,
    missingByMerchant,
    created: totalCreated || 0,
    failed: totalFailed || 0,
  });

  console.log("\n✅ FIX complete");
  console.log("   created:", totalCreated);
  console.log("   failed:", totalFailed);
}

if (require.main === module) {
  run().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

module.exports = { run };
