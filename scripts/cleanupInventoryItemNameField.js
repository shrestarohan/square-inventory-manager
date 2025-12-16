// scripts/cleanupInventoryItemNameField.js
require('dotenv').config();

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

// Defaults:
// - MERCHANT_ID env var, or hard-coded ML1AH5AM3K151
// - DRY_RUN=true by default for safety
const MERCHANT_ID = process.env.MERCHANT_ID || 'ML1AH5AM3K151';
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const SAMPLE_LIMIT = process.env.SAMPLE_LIMIT
  ? parseInt(process.env.SAMPLE_LIMIT, 10)
  : null;

async function cleanupItemNameField() {
  console.log(
    `Starting cleanup of itemName field in merchants/${MERCHANT_ID}/inventory (DRY_RUN=${DRY_RUN}, SAMPLE_LIMIT=${SAMPLE_LIMIT || 'none'})`
  );

  const colRef = firestore
    .collection('merchants')
    .doc(MERCHANT_ID)
    .collection('inventory');

  const PAGE_SIZE = 500;
  let lastDoc = null;
  let processedDocs = 0;
  let cleanedDocs = 0;

  while (true) {
    let query = colRef.orderBy('__name__').limit(PAGE_SIZE);
    if (lastDoc) {
      query = colRef.orderBy('__name__').startAfter(lastDoc).limit(PAGE_SIZE);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      console.log('No more docs, done scanning.');
      break;
    }

    let batch = firestore.batch();
    let batchCount = 0;

    for (const doc of snapshot.docs) {
      processedDocs++;

      if (SAMPLE_LIMIT && processedDocs > SAMPLE_LIMIT) {
        console.log(
          `Reached SAMPLE_LIMIT=${SAMPLE_LIMIT}, stopping further processing.`
        );
        break;
      }

      const data = doc.data();

      // Only touch docs that actually have itemName (the wrong field)
      if (Object.prototype.hasOwnProperty.call(data, 'itemName')) {
        cleanedDocs++;
        console.log(
          `Doc ${doc.id}: deleting field "itemName" (item_name="${data.item_name || ''}")` +
            (DRY_RUN ? ' [DRY RUN]' : '')
        );

        if (!DRY_RUN) {
          batch.update(doc.ref, {
            itemName: FieldValue.delete(),
          });
          batchCount++;

          if (batchCount >= 400) {
            console.log(`Committing batch of ${batchCount} updates…`);
            await batch.commit();
            batch = firestore.batch();
            batchCount = 0;
          }
        }
      }
    }

    if (!DRY_RUN && batchCount > 0) {
      console.log(`Committing final batch of ${batchCount} updates for this page…`);
      await batch.commit();
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (SAMPLE_LIMIT && processedDocs >= SAMPLE_LIMIT) {
      break;
    }
  }

  console.log(
    `Done. Processed ${processedDocs} docs, ` +
      `${DRY_RUN ? 'would clean' : 'cleaned'} ${cleanedDocs} docs with itemName field.`
  );
}

cleanupItemNameField().catch((err) => {
  console.error('Error during cleanup:', err);
  process.exit(1);
});
