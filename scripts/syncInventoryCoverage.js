// scripts/syncInventoryCoverage.js
require('dotenv').config();

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

// DRY_RUN=true by default for safety
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// Optional: limit GTINs for testing
const GTIN_SAMPLE_LIMIT = process.env.GTIN_SAMPLE_LIMIT
  ? parseInt(process.env.GTIN_SAMPLE_LIMIT, 10)
  : null;

/**
 * This script:
 *  - Reads all merchants
 *  - For each merchants/{merchantId}/inventory, collects GTINs
 *  - Builds global union of GTINs
 *  - For each merchant, finds which GTINs they are missing
 *  - Creates placeholder docs for missing GTINs with qty=0
 *  - Uses that merchant's "default" location_id/location_name
 *
 *  PLACEHOLDER DOC FIELDS:
 *    - location_id/location_name: inferred from existing inventory for that merchant
 *    - qty: 0
 *    - state: "MISSING"
 *    - synthetic: true
 */

async function main() {
  console.log(
    `Starting inventory coverage sync (DRY_RUN=${DRY_RUN}, GTIN_SAMPLE_LIMIT=${GTIN_SAMPLE_LIMIT || 'none'})`
  );

  // 1) Load merchant list
  const merchantsSnap = await firestore.collection('merchants').get();
  if (merchantsSnap.empty) {
    console.log('No merchants found, exiting.');
    return;
  }

  const merchants = merchantsSnap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  console.log(`Found ${merchants.length} merchants:`, merchants.map(m => m.id));

  // 2) For each merchant, collect GTINs and track a sample record per GTIN
  const gtinsByMerchant = new Map(); // merchantId -> Set(gtin)
  const globalGtinSet = new Set();   // union of all gtins
  const sampleByGtin = new Map();    // gtin -> sample payload (item_name, sku, price, category, image_urls)
  const defaultLocationByMerchant = new Map(); // merchantId -> { location_id, location_name }

  const READ_PAGE_SIZE = 1000;

  for (const merchant of merchants) {
    const merchantId = merchant.id;
    console.log(`\nCollecting GTINs for merchant ${merchantId} (${merchant.business_name || 'Unnamed'})`);

    const colRef = firestore
      .collection('merchants')
      .doc(merchantId)
      .collection('inventory');

    const gtinSet = new Set();
    gtinsByMerchant.set(merchantId, gtinSet);

    let lastDoc = null;
    let totalDocs = 0;
    let done = false;

    while (!done) {
      let query = colRef.orderBy('__name__').limit(READ_PAGE_SIZE);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snap = await query.get();
      if (snap.empty) {
        console.log(`Merchant ${merchantId}: no more inventory docs to read.`);
        break;
      }

      totalDocs += snap.size;
      console.log(
        `Merchant ${merchantId}: read page with ${snap.size} docs (total so far: ${totalDocs})`
      );

      for (const doc of snap.docs) {
        const data = doc.data();
        const gtin = data.gtin || null;
        if (!gtin) continue;

        // Track default location for this merchant (first non-empty location we see)
        if (!defaultLocationByMerchant.has(merchantId)) {
          if (data.location_id || data.location_name) {
            defaultLocationByMerchant.set(merchantId, {
              location_id: data.location_id || null,
              location_name: data.location_name || '',
            });
          }
        }

        gtinSet.add(gtin);
        globalGtinSet.add(gtin);

        if (!sampleByGtin.has(gtin)) {
          sampleByGtin.set(gtin, {
            gtin,
            item_name: data.item_name || '',
            variation_name: data.variation_name || '',
            sku: data.sku || '',
            category_name: data.category_name || '',
            price: data.price || null,
            currency: data.currency || null,
            image_urls: Array.isArray(data.image_urls)
              ? data.image_urls
              : (data.image_urls ? [data.image_urls] : []),

            // ✅ NEW: copy tax from a real doc
            tax_ids: Array.isArray(data.tax_ids) ? data.tax_ids : [],
            tax_names: Array.isArray(data.tax_names) ? data.tax_names : [],
            tax_percentages: Array.isArray(data.tax_percentages)
              ? data.tax_percentages
              : [],
          });
        }


        if (GTIN_SAMPLE_LIMIT && globalGtinSet.size >= GTIN_SAMPLE_LIMIT) {
          console.log(
            `Global GTIN SAMPLE limit ${GTIN_SAMPLE_LIMIT} reached, stopping GTIN collection early.`
          );
          done = true;
          break;
        }
      }

      lastDoc = snap.docs[snap.docs.length - 1];
    }

    console.log(
      `Merchant ${merchantId}: collected ${gtinSet.size} distinct GTINs (from ${totalDocs} docs).`
    );
  }

  console.log(
    `\nGlobal union: ${globalGtinSet.size} distinct GTINs across all merchants.`
  );

  // 3) For each merchant, determine missing GTINs and optionally create placeholder docs
  const globalGtinList = Array.from(globalGtinSet);

  for (const merchant of merchants) {
    const merchantId = merchant.id;
    const merchantName = merchant.business_name || merchantId;
    const merchantGtins = gtinsByMerchant.get(merchantId) || new Set();

    const missingGtins = globalGtinList.filter((g) => !merchantGtins.has(g));

    console.log(
      `\nMerchant ${merchantId} (${merchantName}) is missing ${missingGtins.length} GTINs out of ${globalGtinList.length}.`
    );

    if (missingGtins.length === 0) continue;

    if (DRY_RUN) {
      console.log(
        `DRY_RUN mode: would create placeholder inventory docs for these GTINs. Sample missing:`,
        missingGtins.slice(0, 10)
      );
      continue;
    }

    // Determine default location for this merchant
    const defLoc =
      defaultLocationByMerchant.get(merchantId) || {
        location_id: 'DEFAULT',
        location_name: 'Default Location',
      };

    const colRef = firestore
      .collection('merchants')
      .doc(merchantId)
      .collection('inventory');

    const masterRef = firestore.collection('inventory');

    const BATCH_LIMIT = 400;
    let batch = firestore.batch();
    let batchCount = 0;
    let createdDocs = 0;

    for (const gtin of missingGtins) {
      const sample = sampleByGtin.get(gtin) || { gtin };

      // Use a deterministic doc ID for placeholders
      const safeGtin = gtin.replace(/[^A-Za-z0-9]/g, '_');
      const docId = `${merchantId}_${defLoc.location_id || 'DEFAULT'}_${safeGtin}_MISSING`;

      const payload = {
        merchant_id: merchantId,
        merchant_name: merchantName,

        // ✅ use merchant's default location instead of VIRTUAL
        location_id: defLoc.location_id || 'DEFAULT',
        location_name: defLoc.location_name || 'Default Location',
        catalog_object_id: null,
        item_id: null,
        variation_id: null,

        gtin: sample.gtin || gtin,
        item_name: sample.item_name || `Unknown Item ${gtin}`,
        variation_name: sample.variation_name || '',
        sku: sample.sku || '',
        category_id: null,
        category_name: sample.category_name || '',

        price: sample.price || null,
        currency: sample.currency || null,

        image_urls: sample.image_urls || [],

        // ✅ copy sales tax from sample doc
        tax_ids: sample.tax_ids || [],
        tax_names: sample.tax_names || [],
        tax_percentages: sample.tax_percentages || [],

        // ✅ new placeholders: qty 0, existing docs untouched
        qty: 0,
        state: 'MISSING',

        calculated_at: null,
        updated_at: new Date().toISOString(),

        synthetic: true,
        synthetic_reason: 'missing_in_merchant_sync',
      };

      // 1) write to per-merchant inventory (placeholder only)
      batch.set(colRef.doc(docId), payload, { merge: true });

      // 2) also write to master inventory (if you want global consistency)
      batch.set(masterRef.doc(docId), payload, { merge: true });

      batchCount++;
      createdDocs++;

      if (batchCount >= BATCH_LIMIT) {
        console.log(
          `Merchant ${merchantId}: committing batch of ${batchCount} placeholder inventory docs...`
        );
        await batch.commit();
        batch = firestore.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      console.log(
        `Merchant ${merchantId}: committing final batch of ${batchCount} placeholder inventory docs...`
      );
      await batch.commit();
    }

    console.log(
      `Merchant ${merchantId}: created ${createdDocs} placeholder inventory docs for missing GTINs.`
    );
  }

  console.log('\nDone syncing inventory coverage across merchants.');
}

main().catch((err) => {
  console.error('Fatal error in inventory coverage sync:', err);
  process.exit(1);
});
