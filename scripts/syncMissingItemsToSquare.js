// scripts/syncMissingItemsToSquare.js
require("../lib/loadEnv"); // adjust relative path

const {
  createSquareClient,
  buildCatalogMaps,
} = require('../lib/inventorySync');

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

// Safety: DRY_RUN=true by default
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

// Optional: limit how many new items to create per merchant for testing
const ITEM_LIMIT = process.env.ITEM_LIMIT
  ? parseInt(process.env.ITEM_LIMIT, 10)
  : null;

// Target a single merchant or all
const TARGET_MERCHANT_ID = process.env.MERCHANT_ID || process.argv[2] || null;

/**
 * For one merchant:
 *  - Build Square catalog maps so we can check existing items
 *  - Find synthetic/missing inventory docs in Firestore
 *  - For each GTIN that doesn't exist in Square yet, create a new ITEM + VARIATION
 *  - Update Firestore placeholder doc with new Square IDs
 */
async function syncMissingItemsForMerchant(merchantDoc) {
  const data = merchantDoc.data();
  const merchantId = merchantDoc.id;
  const env = data.env || 'sandbox';

  console.log(
    `\n=== Syncing missing Firestore items -> Square for merchant ${merchantId} (${data.business_name || 'Unnamed'}) [env=${env}] ===`
  );

  if (!data.access_token) {
    console.warn(`Merchant ${merchantId} missing access_token, skipping.`);
    return;
  }

  const client = createSquareClient(data.access_token, env);

  // 1) Build catalog maps so we can check if an item with this GTIN already exists
  const { itemsById, variationsById } = await buildCatalogMaps(client);

  // Build a quick lookup: gtin -> itemId for this merchant
  const gtinToItemId = new Map();
  for (const [itemId, itemObj] of Object.entries(itemsById)) {
    const variations = itemObj.itemData?.variations || [];
    for (const v of variations) {
      const upc =
        v.itemVariationData?.upc ||
        v.itemVariationData?.sku ||
        null;
      if (upc) {
        gtinToItemId.set(upc, itemId);
      }
    }
  }

  // 2) Find synthetic placeholders that need Square items
  const invColRef = firestore
    .collection('merchants')
    .doc(merchantId)
    .collection('inventory');

  let query = invColRef.where('synthetic', '==', true);
  // Only those without a catalog_object_id or item_id yet
  query = query.where('catalog_object_id', '==', null);

  const snap = await query.get();
  if (snap.empty) {
    console.log(
      `Merchant ${merchantId}: no synthetic placeholder docs without catalog_object_id, nothing to sync.`
    );
    return;
  }

  console.log(
    `Merchant ${merchantId}: found ${snap.size} synthetic placeholder docs with no catalog_object_id.`
  );

  // Group by GTIN (1 Square item per GTIN per merchant)
  const placeholdersByGtin = new Map();

  snap.docs.forEach((doc) => {
    const d = doc.data();
    const gtin = d.gtin || null;
    if (!gtin) return;

    // Skip if Square already has an item with this GTIN
    if (gtinToItemId.has(gtin)) {
      console.log(
        `Merchant ${merchantId}: GTIN ${gtin} already exists in Square catalog (item ${gtinToItemId.get(
          gtin
        )}), skipping placeholder doc ${doc.id}.`
      );
      return;
    }

    if (!placeholdersByGtin.has(gtin)) {
      placeholdersByGtin.set(gtin, {
        sampleDoc: doc,
        docs: [doc],
      });
    } else {
      placeholdersByGtin.get(gtin).docs.push(doc);
    }
  });

  const gtinsToCreate = Array.from(placeholdersByGtin.keys());

  if (gtinsToCreate.length === 0) {
    console.log(
      `Merchant ${merchantId}: no GTINs require new Square items (all GTINs already exist in catalog).`
    );
    return;
  }

  if (ITEM_LIMIT && gtinsToCreate.length > ITEM_LIMIT) {
    console.log(
      `Merchant ${merchantId}: ITEM_LIMIT=${ITEM_LIMIT}, will only process first ${ITEM_LIMIT} GTINs out of ${gtinsToCreate.length}.`
    );
  }

  const toProcess = ITEM_LIMIT
    ? gtinsToCreate.slice(0, ITEM_LIMIT)
    : gtinsToCreate;

  console.log(
    `Merchant ${merchantId}: will create new Square items for ${toProcess.length} GTINs.`
  );

  // 3) Build Square catalog ITEM + VARIATION objects for these GTINs
  const catalogObjectsToCreate = [];
  const tempIdMap = new Map(); // tempId -> { gtin, sampleDoc }

  let counter = 0;
  for (const gtin of toProcess) {
    const { sampleDoc } = placeholdersByGtin.get(gtin);
    const d = sampleDoc.data();

    const itemName = d.item_name || `Unknown Item ${gtin}`;
    const variationName = d.variation_name || 'Default';
    const sku = d.sku || gtin;
    const price = d.price || 0;
    const currency = d.currency || 'USD';

    const itemTempId = `#fs_item_${merchantId}_${counter}`;
    const variationTempId = `#fs_var_${merchantId}_${counter}`;
    counter++;

    tempIdMap.set(itemTempId, {
      gtin,
      sampleDoc,
      variationTempId,
    });

    catalogObjectsToCreate.push(
      {
        type: 'ITEM',
        id: itemTempId,
        itemData: {
          name: itemName,
          // Optional: category_name could be matched to an existing CATEGORY here
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: variationTempId,
              itemVariationData: {
                name: variationName,
                sku,
                upc: gtin,
                pricingType: 'FIXED_PRICING',
                priceMoney: {
                  amount: Math.round(Number(price || 0) * 100),
                  currency,
                },
              },
            },
          ],
        },
      }
    );
  }

  console.log(
    `Merchant ${merchantId}: prepared ${catalogObjectsToCreate.length} catalog ITEM objects for creation.`
  );

  if (DRY_RUN) {
    console.log(
      `DRY_RUN=TRUE: would call Square batchUpsertCatalogObjects with ${catalogObjectsToCreate.length} objects for merchant ${merchantId}.`
    );
    return;
  }

  if (catalogObjectsToCreate.length === 0) {
    console.log(`Merchant ${merchantId}: nothing to create, exiting.`);
    return;
  }

  // 4) Call Square Catalog API to create these items (in batches)
  const { catalogApi } = client;
  const BATCH_SIZE = 50;

  let createdCount = 0;

  for (let i = 0; i < catalogObjectsToCreate.length; i += BATCH_SIZE) {
    const chunk = catalogObjectsToCreate.slice(i, i + BATCH_SIZE);
    const idempotencyKey = `fs-missing-items-${merchantId}-${Date.now()}-${i}`;

    console.log(
      `Merchant ${merchantId}: sending batchUpsertCatalogObjects with ${chunk.length} objects (batch starting at index ${i})`
    );

    const res = await catalogApi.batchUpsertCatalogObjects({
      idempotencyKey,
      batches: [{ objects: chunk }],
    });

    const returnedObjects = res.result.objects || [];
    console.log(
      `Merchant ${merchantId}: Square returned ${returnedObjects.length} catalog objects.`
    );

    // 5) Map returned ITEM/VARIATION IDs back to GTIN + Firestore docs
    // and update Firestore placeholders
    const updatesByDocRef = new Map();

    for (const obj of returnedObjects) {
      // When Square resolves temp IDs, any object whose id starts with "#fs_item..."
      // will have "catalogObjectId" changed, but Square keeps "sourceObject" info in "idMappings"
      // However, simpler: use "res.result.idMappings" if present, or rely on itemData.name+gtin.
    }

    // Prefer using idMappings from batchUpsert result
    const idMappings = res.result.idMappings || [];
    idMappings.forEach((map) => {
      const tempId = map.clientObjectId;
      const realId = map.objectId;

      const info = tempIdMap.get(tempId);
      if (!info) return;

      const { gtin, sampleDoc, variationTempId } = info;

      // Find the variation's real ID mapping too
      const varMapping = idMappings.find(
        (m) => m.clientObjectId === variationTempId
      );
      const variationId = varMapping ? varMapping.objectId : null;

      // Prepare Firestore updates for this doc (and any other doc with same GTIN)
      const { docs } = placeholdersByGtin.get(gtin) || { docs: [sampleDoc] };

      docs.forEach((doc) => {
        updatesByDocRef.set(doc.ref.path, {
          item_id: realId,
          variation_id: variationId,
          catalog_object_id: variationId || realId,
          synthetic: true,
          state: 'MISSING', // still missing qty, but now exists in Square
          square_created_at: new Date().toISOString(),
        });
      });
    });

    // Commit Firestore updates for this batch
    if (updatesByDocRef.size > 0) {
      const batchFs = firestore.batch();
      updatesByDocRef.forEach((update, path) => {
        const ref = firestore.doc(path);
        batchFs.set(ref, update, { merge: true });
        createdCount++;
      });

      console.log(
        `Merchant ${merchantId}: committing Firestore updates for ${updatesByDocRef.size} placeholder docs.`
      );
      await batchFs.commit();
    }
  }

  console.log(
    `Merchant ${merchantId}: finished creating Square items and updating Firestore for ${createdCount} docs.`
  );
}

/**
 * Entry point
 */
async function main() {
  console.log(
    `Starting Firestore synthetic -> Square item sync (DRY_RUN=${DRY_RUN}, ITEM_LIMIT=${ITEM_LIMIT || 'none'}, TARGET_MERCHANT_ID=${TARGET_MERCHANT_ID || 'ALL'})`
  );

  const merchantsCol = firestore.collection('merchants');

  if (TARGET_MERCHANT_ID) {
    const doc = await merchantsCol.doc(TARGET_MERCHANT_ID).get();
    if (!doc.exists) {
      console.error(`Merchant "${TARGET_MERCHANT_ID}" not found in Firestore.`);
      return;
    }
    await syncMissingItemsForMerchant(doc);
    return;
  }

  const snapshot = await merchantsCol.get();
  console.log(`Found ${snapshot.size} merchants.`);

  for (const doc of snapshot.docs) {
    try {
      await syncMissingItemsForMerchant(doc);
    } catch (err) {
      console.error(
        `Error syncing missing items for merchant ${doc.id}:`,
        err
      );
    }
  }

  console.log('Finished Firestore synthetic -> Square item sync for all merchants.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error in syncMissingItemsToSquare:', err);
    process.exit(1);
  });
}

module.exports = {
  syncMissingItemsForMerchant,
};
