// scripts/properCaseItemNames.js
require('dotenv').config();

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

const DRY_RUN = process.env.DRY_RUN === 'true';
const SAMPLE_LIMIT = process.env.SAMPLE_LIMIT
  ? parseInt(process.env.SAMPLE_LIMIT, 10)
  : null;

function toProper(str) {
  if (!str) return str;

  // 1) Basic title-case behavior
  let result = str
    .toLowerCase()
    .replace(/\b([a-z0-9à-öø-ÿ]+)/gi, (word) => {
      return word.charAt(0).toUpperCase() + word.slice(1);
    });

  // 2) Specific ml sizes → XXML
  // allow "50ml", "50 ml", "50ML", etc.
  result = result.replace(/\b50\s*ml\b/gi, '50ML');
  result = result.replace(/\b100\s*ml\b/gi, '100ML');
  result = result.replace(/\b200\s*ml\b/gi, '200ML');
  result = result.replace(/\b375\s*ml\b/gi, '375ML');
  result = result.replace(/\b750\s*ml\b/gi, '750ML');// ✅ NEW: keep 355ML uppercase

  // 3) Specific L sizes → XL
  // allow "1l", "1 l", "1L", etc.
  result = result.replace(/\b1\s*l\b/gi, '1L');
  result = result.replace(/\b1\.5\s*l\b/gi, '1.5L');
  result = result.replace(/\b1\.75\s*l\b/gi, '1.75L');

  // 4) Ounce fixes

  // 4a) Normalize "<number> fl oz" -> "<number>oz"
  // e.g. "16fl Oz", "16 fl oz", "16 FL OZ" -> "16oz"
  result = result.replace(/(\d+(?:\.\d+)?)\s*fl\s*oz\b/gi, '$1oz');

  // 4b) Normalize "<number> oz|Oz|OZ" -> "<number>oz"
  // (handles "15.20 Oz", "12 OZ", etc.)
  result = result.replace(/(\d+(?:\.\d+)?)(\s*)oz\b/gi, '$1oz');

  return result;
}


async function properCaseItemNames() {
  const collectionName = process.env.ITEM_NAME_COLLECTION || 'gtinMeta';
  console.log(`Using collection: ${collectionName}`);
  console.log(`DRY_RUN = ${DRY_RUN}`);
  if (SAMPLE_LIMIT) {
    console.log(`SAMPLE_LIMIT = ${SAMPLE_LIMIT} docs`);
  }

  const colRef = firestore.collection(collectionName);
  const READ_PAGE_SIZE = 1000;   // docs per read page
  const BATCH_LIMIT = 400;       // writes per commit (under Firestore 500 limit)

  let processed = 0;
  let updated = 0;
  let totalDocsSeen = 0;
  let lastDoc = null;
  let done = false;

  while (!done) {
    let query = colRef.orderBy('__name__').limit(READ_PAGE_SIZE);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      console.log('No more documents in this page, finished reading.');
      break;
    }

    totalDocsSeen += snapshot.size;
    console.log(`Read page with ${snapshot.size} docs (total seen: ${totalDocsSeen})`);

    let batch = firestore.batch();
    let batchCount = 0;

    for (const doc of snapshot.docs) {
      processed++;

      if (SAMPLE_LIMIT && processed > SAMPLE_LIMIT) {
        console.log(`Reached SAMPLE_LIMIT (${SAMPLE_LIMIT}) – stopping.`);
        done = true;
        break;
      }

      const data = doc.data();
      const originalName = data.item_name; //changed itemName to item_name

      if (!originalName || typeof originalName !== 'string') {
        continue;
      }

      const properName = toProper(originalName);

      if (properName === originalName) {
        continue;
      }

      console.log(
        `Doc ${doc.id}: "${originalName}" -> "${properName}"` +
          (DRY_RUN ? ' [DRY RUN]' : '')
      );

      updated++;

      if (!DRY_RUN) {
        batch.update(doc.ref, {
          item_name: properName,  //changed itemName to item_name
          itemNameProperUpdatedAt: new Date().toISOString(),
        });
        batchCount++;

        if (batchCount >= BATCH_LIMIT) {
          console.log(`Committing batch of ${batchCount} updates…`);
          await batch.commit();
          batch = firestore.batch();
          batchCount = 0;
        }
      }
    }

    if (!DRY_RUN && batchCount > 0) {
      console.log(`Committing final batch of ${batchCount} updates for this page…`);
      await batch.commit();
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }

  console.log(
    `Done. Processed ${processed} docs, ${
      DRY_RUN ? 'would update' : 'updated'
    } ${updated} itemName fields.`
  );
}

properCaseItemNames().catch((err) => {
  console.error('Error while proper-casing item names:', err);
  process.exit(1);
});
