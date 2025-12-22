// scripts/fullNightlySync.js
require("../lib/loadEnv"); // adjust relative path

const { syncAllMerchants } = require('../lib/inventorySync');
const { buildGtinMatrix } = require('./buildGtinMatrix');

(async () => {
  try {
    console.log('🚀 Starting full nightly sync...');
    const start = Date.now();

    // 1) Pull from Square → Firestore
    await syncAllMerchants();
    console.log('✅ syncAllMerchants done in', ((Date.now() - start) / 1000).toFixed(1), 'sec');

    // 2) Rebuild gtin_matrix + location_index
    if (typeof buildGtinMatrix.main === 'function') {
      await buildGtinMatrix.main();
    } else {
      await buildGtinMatrix();
    }
    console.log('✅ buildGtinMatrix done');

    // 3) Update “last sync” meta
    const { Firestore } = require('@google-cloud/firestore');
    const firestore = new Firestore();
    await firestore
      .collection('meta')
      .doc('sync_status')
      .set(
        {
          last_full_sync_at: new Date().toISOString(),
        },
        { merge: true }
      );

    console.log('🎉 Full nightly sync completed.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Full nightly sync FAILED:', err);
    process.exit(1);
  }
})();
