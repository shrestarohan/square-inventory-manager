// scripts/syncInventory.js
require("../lib/loadEnv"); // adjust relative path

const {
  syncAllMerchants,
  syncMerchantInventory,
} = require('../lib/inventorySync');

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

// Allow filtering to one merchant:
// - MERCHANT_ID env var
// - or first CLI arg
const TARGET_MERCHANT_ID =
  process.env.MERCHANT_ID || process.argv[2] || null;

async function main() {
  console.log(
    `Starting inventory sync (TARGET_MERCHANT_ID=${TARGET_MERCHANT_ID || 'ALL'})`
  );

  if (TARGET_MERCHANT_ID) {
    // Run for a single merchant
    const doc = await firestore
      .collection('merchants')
      .doc(TARGET_MERCHANT_ID)
      .get();

    if (!doc.exists) {
      console.error(
        `Merchant document "${TARGET_MERCHANT_ID}" not found in Firestore.`
      );
      process.exit(1);
    }

    await syncMerchantInventory(doc);
    console.log(
      `Finished inventory sync for merchant ${TARGET_MERCHANT_ID}.`
    );
    return;
  }

  // Otherwise, run for all merchants
  await syncAllMerchants();
  console.log('Finished inventory sync for all merchants.');
}

main().catch((err) => {
  console.error('Fatal error in inventory sync:', err);
  process.exit(1);
});
