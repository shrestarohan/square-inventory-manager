// scripts/backfillSearchFields.js
require('dotenv').config();
const firestore = require('../lib/firestore');

const BATCH_SIZE = 400;

async function backfillCollection(colRef) {
  let last = null;
  let updated = 0;

  while (true) {
    let q = colRef.orderBy('__name__').limit(BATCH_SIZE);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = firestore.batch();

    snap.docs.forEach((doc) => {
      const d = doc.data() || {};
      const itemName = (d.item_name || '').toString().trim();
      const sku = (d.sku || '').toString().trim();

      batch.set(
        doc.ref,
        {
          item_name_lc: itemName ? itemName.toLowerCase() : null,
          sku_lc: sku ? sku.toLowerCase() : null,
        },
        { merge: true }
      );
      updated++;
    });

    await batch.commit();
    last = snap.docs[snap.docs.length - 1];
    console.log(`Updated ~${updated} docs...`);
  }

  return updated;
}

async function main() {
  console.log('Backfilling master inventory...');
  await backfillCollection(firestore.collection('inventory'));

  console.log('Backfilling merchant subcollections...');
  const merchants = await firestore.collection('merchants').get();
  for (const m of merchants.docs) {
    console.log(`Merchant ${m.id}...`);
    await backfillCollection(
      firestore.collection('merchants').doc(m.id).collection('inventory')
    );
  }

  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
