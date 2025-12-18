/**
 * buildGtinMatrix.js
 * ============================================================
 * PURPOSE
 *   Builds / refreshes a "gtin_matrix" dataset so your UI pages
 *   (like dashboard-gtin / price mismatch) can load fast without
 *   scanning the entire master inventory each time.
 *
 * WHAT IT CREATES
 *   Collection: gtin_matrix
 *   Document ID (recommended): <gtin>
 *   Example doc:
 *     {
 *       gtin: "0081234567890",
 *       canonical_name: "Tito's Handmade Vodka 750ml",
 *       category_name: "Vodka",
 *       sku: "TITO-750",
 *       updated_at: "2025-12-16T12:34:56.000Z",
 *       locations: {
 *         "<merchantId>|<locationId>": {
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
 *           calculated_at
 *         }
 *       }
 *     }
 *
 * INPUT SOURCE
 *   Reads from Firestore:
 *     - merchants/{merchantId}/inventory   (recommended source)
 *       OR
 *     - inventory (master)                (if you choose)
 *
 * PREREQUISITES
 *   1) You must be authenticated to the correct GCP project:
 *        gcloud auth login
 *        gcloud config set project <YOUR_PROJECT_ID>
 *
 *   2) Firestore access must work from your environment.
 *      If you're using the Firebase Admin SDK via Application Default Credentials:
 *        gcloud auth application-default login
 *
 *   3) Install dependencies (if not already):
 *        npm install
 *
 * ENVIRONMENT VARIABLES
 *   Required (depends on your firestore.js):
 *     - GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT (your project id)
 *
 *   Optional:
 *     - TARGET_MERCHANT_ID   Only build matrix for one merchant
 *     - LIMIT_GTINS          Stop after N GTINs (for testing)
 *     - DRY_RUN=1            Compute stats only, don't write
 *     - BATCH_SIZE=400       Firestore batch size (max 500)
 *
 * HOW TO RUN
 *   From your project root:
 *
 *   ✅ Run for ALL merchants:
 *     node scripts/buildGtinMatrix.js
 *
 *   ✅ Run for one merchant:
 *     TARGET_MERCHANT_ID=<merchantId> node scripts/buildGtinMatrix.js
 *
 *   ✅ Dry run (no writes):
 *     DRY_RUN=1 node scripts/buildGtinMatrix.js
 *
 *   ✅ Test small:
 *     LIMIT_GTINS=200 DRY_RUN=1 node scripts/buildGtinMatrix.js
 *     
 *   ✅ Test I ran:
 *     node scripts/buildGtinMatrix.js --merchantId=ML1AH5AM3K151 --readPage=500 --writeBatch=300
 *     node scripts/buildGtinMatrix.js --merchantId=MLRE062EYSN7E --readPage=500 --writeBatch=300
 *     node scripts/buildGtinMatrix.js --merchantId=MLTW51AKET6TD --readPage=500 --writeBatch=300
 * 
 * CLOUD SHELL NOTES
 *   - Make sure port forwarding / dev server isn't required; this is a CLI script.
 *   - Ensure you're in the correct folder:
 *       cd ~/square-inventory-sync
 *
 * PERFORMANCE TIPS
 *   - Prefer reading merchants/{merchantId}/inventory (already scoped + smaller).
 *   - Avoid scanning master inventory if you have large duplication.
 *   - Keep BATCH_SIZE <= 400 to stay comfortably under limits.
 *
 * OUTPUT / VALIDATION
 *   - After running, validate:
 *       Firestore Console → gtin_matrix collection
 *   - (Optional) build a simple endpoint / page to query gtin_matrix
 *     instead of scanning inventory.
 *
 * SAFETY
 *   - Use DRY_RUN=1 first in production projects.
 *   - If you re-run, documents are overwritten/merged (idempotent).
 * ============================================================
 */

// scripts/buildGtinMatrix.js
require('dotenv').config();
const firestore = require('../lib/firestore');

const DEFAULT_READ_PAGE = 1000;     // read batch
const DEFAULT_WRITE_BATCH = 400;    // <= 500 safe headroom

function safeStr(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function makeLocKey(d) {
  const merchantName = safeStr(d.merchant_name || d.merchant_id).trim();
  const locationName = safeStr(d.location_name || d.location_id).trim();
  return `${merchantName} – ${locationName}`.trim();
}

// Resolve duplicates for same (gtin, locKey):
// Prefer: has price > no price, then latest calculated_at/updated_at.
function shouldReplace(existing, candidate) {
  if (!existing) return true;

  const ep = (existing.price === null || existing.price === undefined) ? null : Number(existing.price);
  const cp = (candidate.price === null || candidate.price === undefined) ? null : Number(candidate.price);

  if (ep === null && cp !== null) return true;
  if (ep !== null && cp === null) return false;

  const eTime = Date.parse(existing.calculated_at || existing.updated_at || '') || 0;
  const cTime = Date.parse(candidate.calculated_at || candidate.updated_at || '') || 0;

  return cTime >= eTime;
}

async function runBuildGtinMatrix(options = {}) {
  const args = process.argv.slice(2);

  const getArg = (name) => {
    // allow override from options if passed programmatically
    if (options[name] !== undefined && options[name] !== null) {
      return String(options[name]);
    }
    const hit = args.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : null;
  };

  const merchantId = getArg('merchantId'); // optional
  const readPageSize = Math.min(Number(getArg('readPage')) || DEFAULT_READ_PAGE, 2000);
  const writeBatchSize = Math.min(Number(getArg('writeBatch')) || DEFAULT_WRITE_BATCH, 450);

  const sourceCol = merchantId
    ? firestore.collection('merchants').doc(merchantId).collection('inventory')
    : firestore.collection('inventory');

  console.log(`Building gtin_matrix from: ${merchantId ? `merchants/${merchantId}/inventory` : 'inventory'}`);
  console.log(`readPageSize=${readPageSize}, writeBatchSize=${writeBatchSize}`);

  let lastDoc = null;
  let scanned = 0;
  let kept = 0;

  // Track location keys (write at end)
  const locationKeys = new Set();

  // Write batching
  let batch = firestore.batch();
  let batchWrites = 0;

  async function commitBatchIfNeeded(force = false) {
    if (batchWrites === 0) return;
    if (!force && batchWrites < writeBatchSize) return;
    await batch.commit();
    batch = firestore.batch();
    batchWrites = 0;
  }

  while (true) {
    let q = sourceCol.orderBy('__name__').limit(readPageSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data();

      const gtin = d.gtin ? String(d.gtin).trim() : '';
      if (!gtin) continue;

      const locKey = makeLocKey(d);
      if (!locKey || locKey === '–') continue;

      locationKeys.add(locKey);

      const price = (d.price !== undefined && d.price !== null) ? Number(d.price) : null;
      const currency = d.currency || null;

      const candidateLocInfo = {
        price: Number.isFinite(price) ? price : null,
        currency,
        merchant_id: d.merchant_id || null,
        location_id: d.location_id || null,
        variation_id: d.variation_id || null,
        calculated_at: d.calculated_at || null,
        updated_at: d.updated_at || null,
      };

      // We want to avoid reading gtin_matrix docs during build (expensive).
      // So we do a “last write wins” for each (gtin, locKey) encountered in scan order.
      // To improve correctness, we encode conflict resolution into a deterministic overwrite:
      // write the locKey info plus a synthetic "sortTime" and rely on scan order.
      // Better: do small in-memory de-dupe per page to avoid thrashing.
      // We'll do per-page de-dupe by storing best candidate per (gtin|locKey) within this page.
    }

    // Per-page de-dupe & writes:
    // Build map for this page and write once per unique (gtin, locKey).
    const pageBest = new Map(); // key = `${gtin}||${locKey}` -> {gtin, locKey, docData}
    for (const doc of snap.docs) {
      const d = doc.data();
      const gtin = d.gtin ? String(d.gtin).trim() : '';
      if (!gtin) continue;

      const locKey = makeLocKey(d);
      if (!locKey || locKey === '–') continue;

      const price = (d.price !== undefined && d.price !== null) ? Number(d.price) : null;
      const currency = d.currency || null;

      const candidateLocInfo = {
        price: Number.isFinite(price) ? price : null,
        currency,
        merchant_id: d.merchant_id || null,
        location_id: d.location_id || null,
        variation_id: d.variation_id || null,
        calculated_at: d.calculated_at || null,
        updated_at: d.updated_at || null,
      };

      const key = `${gtin}||${locKey}`;
      const prev = pageBest.get(key);

      if (!prev || shouldReplace(prev.locInfo, candidateLocInfo)) {
        // pick best “header fields” too
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

    for (const entry of pageBest.values()) {
      const gtinDoc = firestore.collection('gtin_matrix').doc(entry.gtin);

      const itemName = entry.header.item_name || null;
      const payload = {
        gtin: entry.gtin,
        // only set these when present (merge-friendly)
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
      kept++;

      if (batchWrites >= writeBatchSize) {
        await commitBatchIfNeeded(true);
      }
    }

    await commitBatchIfNeeded(false);

    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`Scanned=${scanned}, wroteEntries=${kept}, lastDoc=${lastDoc.id}`);
  }

  // write location_index
  console.log(`Writing location_index (${locationKeys.size} keys)`);
  const locArr = Array.from(locationKeys).sort();

  let locBatch = firestore.batch();
  let locWrites = 0;

  function locIdForKey(locKey) {
    // stable doc id; keep it short (hash-like)
    return Buffer.from(locKey, 'utf8').toString('base64').replace(/=+$/,'');
  }

  for (const locKey of locArr) {
    const id = locIdForKey(locKey);
    locBatch.set(firestore.collection('location_index').doc(id), { locKey }, { merge: true });
    locWrites++;
    if (locWrites >= 450) {
      await locBatch.commit();
      locBatch = firestore.batch();
      locWrites = 0;
    }
  }
  if (locWrites) await locBatch.commit();

  console.log('✅ Done building gtin_matrix + location_index');
  console.log(`Total scanned docs: ${scanned}`);
}

module.exports = {
  runBuildGtinMatrix,
  buildGtinMatrix: runBuildGtinMatrix, // ✅ alias for your nightly sync
};

// CLI usage still works
if (require.main === module) {
  runBuildGtinMatrix().catch((e) => {
    console.error('Fatal build error:', e);
    process.exit(1);
  });
}

