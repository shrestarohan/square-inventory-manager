// scripts/syncGtinNamesToSquare.js
require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');
const { squareClient, buildGtinToVariationMap } = require('../lib/squareCatalog');

const firestore = new Firestore();

const DRY_RUN = process.env.DRY_RUN === 'true';
const SAMPLE_LIMIT = process.env.SAMPLE_LIMIT
  ? parseInt(process.env.SAMPLE_LIMIT, 10)
  : null;

async function syncNamesToSquare() {
  const collectionName = process.env.ITEM_NAME_COLLECTION || 'gtinMeta';
  console.log(`Using Firestore collection: ${collectionName}`);
  console.log(`DRY_RUN = ${DRY_RUN}`);
  if (SAMPLE_LIMIT) console.log(`SAMPLE_LIMIT = ${SAMPLE_LIMIT}`);

  console.log('Building GTIN → Square variation map from Square…');
  const gtinToVar = await buildGtinToVariationMap();
  console.log(`Loaded ${gtinToVar.size} variations with GTIN from Square.`);

  const colRef = firestore.collection(collectionName);
  const snapshot = await colRef.get();

  console.log(`Found ${snapshot.size} docs in Firestore.`);

  const { catalogApi } = squareClient;
  let processed = 0;
  let toUpdate = 0;

  // Square batchUpsert has a max of 10,000 objects, but we’ll stay way below.
  const updates = [];

  for (const doc of snapshot.docs) {
    processed++;
    if (SAMPLE_LIMIT && processed > SAMPLE_LIMIT) {
      console.log(`Reached SAMPLE_LIMIT ${SAMPLE_LIMIT}, stopping.`);
      break;
    }

    const data = doc.data();
    const gtin = data.gtin || doc.id;
    const newName = data.itemName;

    if (!gtin || !newName) continue;

    const variation = gtinToVar.get(gtin);
    if (!variation) {
      // No matching variation in Square
      continue;
    }

    const currentName =
      variation.itemVariationData.name ||
      (variation.itemVariationData.itemId && data.itemName) || ''; // fallback

    if (currentName === newName) {
      // Already in sync
      continue;
    }

    console.log(
      `GTIN ${gtin}: "${currentName}" -> "${newName}" ` +
        (DRY_RUN ? '[DRY RUN]' : '')
    );

    toUpdate++;

    if (!DRY_RUN) {
      // Create a new object for update: must include id, type, and updated data
      updates.push({
        type: 'ITEM_VARIATION',
        id: variation.id,
        version: variation.version,
        itemVariationData: {
          ...variation.itemVariationData,
          name: newName,
        },
      });
    }
  }

  if (!DRY_RUN && updates.length) {
    console.log(`Sending ${updates.length} updates to Square via batchUpsertCatalogObject…`);

    // Square batchUpsertCatalogObject wants objects keyed by a client-supplied ID.
    // We can just use the Square object id as the client ID for idempotency.
    const batches = [];
    const BATCH_SIZE = 50; // keep it modest

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      batches.push(updates.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const objectMap = {};
      for (const obj of batch) {
        objectMap[obj.id] = obj;
      }

      console.log(`Sending batch ${i + 1}/${batches.length} with ${batch.length} objects…`);

      const res = await catalogApi.batchUpsertCatalogObjects({
        idempotencyKey: `gtin-name-sync-${Date.now()}-${i}`,
        batches: [
          {
            objects: Object.values(objectMap),
          },
        ],
      });

      console.log(
        `Square responded for batch ${i + 1}:`,
        res.result.idempotencyKey || '(no idempotency key returned)'
      );
    }
  }

  console.log(
    `Done. Processed ${processed} docs, ${DRY_RUN ? 'would update' : 'updated'} ${toUpdate} variations in Square.`
  );
}

syncNamesToSquare().catch((err) => {
  console.error('Error syncing names to Square:', err);
  process.exit(1);
});
