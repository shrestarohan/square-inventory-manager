// scripts/rebuildMasterInventory.js
require('dotenv').config();
const firestore = require('../lib/firestore'); // shared Firestore client with databaseId support

// DRY_RUN=true by default
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const READ_PAGE_SIZE = 1000;
const BATCH_LIMIT = 400;

async function rebuildMasterInventory() {
  console.log(
    `Starting rebuild of top-level 'inventory' from merchant subcollections (DRY_RUN=${DRY_RUN})`
  );

  const merchantsSnap = await firestore.collection('merchants').get();
  if (merchantsSnap.empty) {
    console.log('No merchants found, exiting.');
    return;
  }

  const merchants = merchantsSnap.docs.map((d) => ({
    id: d.id,
    ref: d.ref,
  }));

  console.log(
    `Found ${merchants.length} merchants:`,
    merchants.map((m) => m.id)
  );

  const masterRef = firestore.collection('inventory');

  let totalDocsSeen = 0;
  let totalWrites = 0;

  for (const merchant of merchants) {
    const merchantId = merchant.id;
    console.log(`\nRebuilding from merchant ${merchantId}…`);

    const invRef = merchant.ref.collection('inventory');
    let lastDoc = null;

    while (true) {
      let query = invRef.orderBy('__name__').limit(READ_PAGE_SIZE);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snap = await query.get();
      if (snap.empty) {
        console.log(
          `Merchant ${merchantId}: no more inventory docs in this page.`
        );
        break;
      }

      console.log(
        `Merchant ${merchantId}: read page with ${snap.size} docs.`
      );

      totalDocsSeen += snap.size;

      let batch = firestore.batch();
      let batchCount = 0;

      for (const doc of snap.docs) {
        const data = doc.data();
        const docId = doc.id; // keep same ID in master

        if (!DRY_RUN) {
          batch.set(masterRef.doc(docId), data, { merge: true });
          batchCount++;
          totalWrites++;
        }

        if (!DRY_RUN && batchCount >= BATCH_LIMIT) {
          console.log(
            `Merchant ${merchantId}: committing batch of ${batchCount} master inventory writes…`
          );
          await batch.commit();
          batch = firestore.batch();
          batchCount = 0;
        }
      }

      if (!DRY_RUN && batchCount > 0) {
        console.log(
          `Merchant ${merchantId}: committing final batch of ${batchCount} master inventory writes for this page…`
        );
        await batch.commit();
      }

      lastDoc = snap.docs[snap.docs.length - 1];
    }
  }

  console.log(
    `\nDone. Saw ${totalDocsSeen} merchant inventory docs, ` +
      `${DRY_RUN ? 'would write' : 'wrote'} ${totalWrites} docs into master 'inventory'.`
  );
}

rebuildMasterInventory().catch((err) => {
  console.error('Error while rebuilding master inventory:', err);
  process.exit(1);
});
