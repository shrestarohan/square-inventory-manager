// scripts/syncFirestoreItemNamesToSquare.js
require('dotenv').config();

const {
    createSquareClient,
    buildCatalogMaps,
} = require('../lib/inventorySync');

const firestore = require('../lib/firestore'); // or './lib/firestore' from root

const DRY_RUN =
    (process.env.DRY_RUN || '').toLowerCase() === 'true';
const SAMPLE_LIMIT = process.env.SAMPLE_LIMIT
    ? parseInt(process.env.SAMPLE_LIMIT, 10)
    : null;

const TARGET_MERCHANT_ID =
    process.env.MERCHANT_ID || process.argv[2] || null;

/**
 * For a single merchant:
 * - Build Square catalog maps (ITEM / VARIATION / CATEGORY / TAX)
 * - Read merchants/{merchantId}/inventory from Firestore
 * - Derive a single canonical item_name per item_id
 * - If Firestore item_name != Square itemData.name, update Square ITEM
 */
async function syncMerchantItemNamesToSquare(merchantDoc) {
    const data = merchantDoc.data();
    const merchantId = merchantDoc.id;
    const env = data.env || 'sandbox';

    console.log(
        `\n=== Syncing item_name Firestore → Square for merchant ${merchantId} (${data.business_name || 'Unnamed'}) [env=${env}] ===`
    );

    if (!data.access_token) {
        console.warn(`Merchant ${merchantId} missing access_token, skipping.`);
        return;
    }

    const client = createSquareClient(data.access_token, env);

    // 1) Build catalog maps so we know current Square item names
    const { itemsById } = await buildCatalogMaps(client);

    // 2) Load Firestore inventory docs for this merchant
    const invColRef = firestore
        .collection('merchants')
        .doc(merchantId)
        .collection('inventory');

    // Build canonical item_name per item_id
    // Use the latest updated_at if multiple docs share the same item_id.
    const perItemName = new Map(); // item_id -> { itemName, updatedAt, docId }

    const PAGE_SIZE = 500; // smaller page size so each chunk returns faster
    let lastDoc = null;
    let totalDocs = 0;

    console.log(`Merchant ${merchantId}: starting inventory scan...`);

    while (true) {
        let query = invColRef.orderBy('__name__').limit(PAGE_SIZE);
        if (lastDoc) {
            query = invColRef.orderBy('__name__').startAfter(lastDoc).limit(PAGE_SIZE);
        }

        const pageSnap = await query.get();

        if (pageSnap.empty) {
            console.log(`Merchant ${merchantId}: no more inventory docs, stopping scan.`);
            break;
        }

        for (const doc of pageSnap.docs) {
            const row = doc.data();
            const itemId = row.item_id;
            const itemName = row.item_name;
            const updatedAt = row.updated_at || null;

            if (!itemId || !itemName) continue;

            const existing = perItemName.get(itemId);
            if (!existing) {
                perItemName.set(itemId, {
                    itemName,
                    updatedAt,
                    docId: doc.id,
                });
            } else {
                if (
                    updatedAt &&
                    (!existing.updatedAt || updatedAt > existing.updatedAt)
                ) {
                    perItemName.set(itemId, {
                        itemName,
                        updatedAt,
                        docId: doc.id,
                    });
                }
            }
        }

        totalDocs += pageSnap.size;
        lastDoc = pageSnap.docs[pageSnap.docs.length - 1];

        console.log(
            `Merchant ${merchantId}: processed ${totalDocs} inventory docs so far (distinct item_ids=${perItemName.size})`
        );

        // 🚨 Early exit when SAMPLE_LIMIT is reached (based on item_ids, not docs)
        if (SAMPLE_LIMIT && perItemName.size >= SAMPLE_LIMIT) {
            console.log(
                `Merchant ${merchantId}: SAMPLE_LIMIT ${SAMPLE_LIMIT} distinct item_ids reached, stopping inventory scan early.`
            );
            break;
        }
    }

    console.log(
        `Merchant ${merchantId}: derived canonical item_name for ${perItemName.size} distinct item_ids.`
    );

    console.log(
        `Derived canonical item_name for ${perItemName.size} distinct item_ids.`
    );

    // 3) Compare with Square and prepare updates
    const updates = [];
    let examined = 0;
    let willChange = 0;

    for (const [itemId, info] of perItemName.entries()) {
        examined++;
        if (SAMPLE_LIMIT && examined > SAMPLE_LIMIT) {
            console.log(
                `SAMPLE_LIMIT ${SAMPLE_LIMIT} reached, stopping further comparisons.`
            );
            break;
        }

        const catalogItem = itemsById[itemId];
        if (!catalogItem || !catalogItem.itemData) {
            // Possibly an orphaned record in Firestore or catalog changed
            continue;
        }

        const squareName = catalogItem.itemData.name || '';
        const newName = info.itemName;

        if (squareName === newName) {
            continue; // already in sync
        }

        willChange++;
        console.log(
            `Merchant ${merchantId} ITEM ${itemId}: "${squareName}" -> "${newName}"` +
            (DRY_RUN ? ' [DRY RUN]' : '')
        );

        if (!DRY_RUN) {
            updates.push({
                type: 'ITEM',
                id: catalogItem.id,
                version: catalogItem.version,
                itemData: {
                    ...catalogItem.itemData,
                    name: newName,
                },
            });
        }
    }

    console.log(
        `Merchant ${merchantId}: examined ${examined} item_ids, ` +
        `${DRY_RUN ? 'would update' : 'will update'} ${willChange} items.`
    );

    if (DRY_RUN || updates.length === 0) {
        console.log(
            `Merchant ${merchantId}: no live updates sent to Square (DRY_RUN=${DRY_RUN}).`
        );
        return;
    }

    // 4) Send updates to Square in batches
    const { catalogApi } = client;
    const BATCH_SIZE = 50;
    let batchIndex = 0;

    while (updates.length > 0) {
        const chunk = updates.splice(0, BATCH_SIZE);
        const idempotencyKey = `fs-itemname-sync-${merchantId}-${Date.now()}-${batchIndex}`;

        console.log(
            `Sending batch ${batchIndex + 1} (${chunk.length} ITEM updates) to Square for merchant ${merchantId}...`
        );

        const res = await catalogApi.batchUpsertCatalogObjects({
            idempotencyKey,
            batches: [
                {
                    objects: chunk,
                },
            ],
        });

        console.log(
            `Square response for merchant ${merchantId}, batch ${batchIndex + 1}:`,
            res.result.idempotencyKey || '(no idempotency key returned)'
        );

        batchIndex++;
    }

    console.log(
        `Merchant ${merchantId}: finished syncing item_name Firestore → Square.`
    );
}

/**
 * Entry point: iterate over all merchants in Firestore and sync item_name
 * changes from Firestore → Square.
 */
async function main() {
    console.log(
        `Starting Firestore → Square item_name sync (DRY_RUN=${DRY_RUN}, SAMPLE_LIMIT=${SAMPLE_LIMIT || 'none'}, TARGET_MERCHANT_ID=${TARGET_MERCHANT_ID || 'ALL'})`
    );

    const merchantsCol = firestore.collection('merchants');

    if (TARGET_MERCHANT_ID) {
        // Run for a single merchant
        const doc = await merchantsCol.doc(TARGET_MERCHANT_ID).get();
        if (!doc.exists) {
            console.error(
                `Merchant document "${TARGET_MERCHANT_ID}" not found in Firestore.`
            );
            return;
        }

        try {
            await syncMerchantItemNamesToSquare(doc);
        } catch (err) {
            console.error(
                `Error syncing item names for merchant ${doc.id}:`,
                err
            );
        }

        console.log(
            `Finished Firestore → Square item_name sync for merchant ${TARGET_MERCHANT_ID}.`
        );
        return;
    }

    // Otherwise, run for ALL merchants
    const snapshot = await merchantsCol.get();
    console.log(`Found ${snapshot.size} merchants.`);

    for (const merchantDoc of snapshot.docs) {
        try {
            await syncMerchantItemNamesToSquare(merchantDoc);
        } catch (err) {
            console.error(
                `Error syncing item names for merchant ${merchantDoc.id}:`,
                err
            );
        }
    }

    console.log('Finished Firestore → Square item_name sync for all merchants.');
}


// Run if executed directly
if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal error in item_name sync script:', err);
        process.exit(1);
    });
}

module.exports = {
    syncMerchantItemNamesToSquare,
};
