// inventorySync.js
const { Firestore } = require('@google-cloud/firestore');
const { Client, Environment } = require('square/legacy');

// If you used a non-default Firestore database ID, pass { databaseId: 'your-id' } here
const firestore = new Firestore();

/**
 * Create a Square client for a given merchant access token + env.
 */
function createSquareClient(accessToken, env) {
  return new Client({
    environment: env === 'sandbox' ? Environment.Sandbox : Environment.Production,
    bearerAuthCredentials: { accessToken },
  });
}

/**
 * Build full catalog lookup maps for:
 * - itemsById (ITEM)
 * - variationsById (ITEM_VARIATION)
 * - categoriesById (CATEGORY)
 * - taxesById (TAX)
 *
 * Uses pagination to pull the entire catalog.
 */
async function buildCatalogMaps(client) {
  const itemsById = {};
  const variationsById = {};
  const categoriesById = {};
  const taxesById = {};

  let cursor = undefined;
  let page = 0;

  do {
    const res = await client.catalogApi.listCatalog(
      cursor,
      'ITEM,ITEM_VARIATION,CATEGORY,TAX'
    );

    const objects = res.result.objects || [];
    console.log(`Catalog page ${page}, objects: ${objects.length}`);

    for (const obj of objects) {
      switch (obj.type) {
        case 'ITEM':
          itemsById[obj.id] = obj;
          break;
        case 'ITEM_VARIATION':
          variationsById[obj.id] = obj;
          break;
        case 'CATEGORY':
          categoriesById[obj.id] = obj;
          break;
        case 'TAX':
          taxesById[obj.id] = obj;
          break;
      }
    }

    cursor = res.result.cursor;
    page++;
  } while (cursor);

  console.log(
    `Catalog maps built: items=${Object.keys(itemsById).length}, ` +
      `variations=${Object.keys(variationsById).length}, ` +
      `categories=${Object.keys(categoriesById).length}, ` +
      `taxes=${Object.keys(taxesById).length}`
  );

  return { itemsById, variationsById, categoriesById, taxesById };
}

/**
 * Sync inventory for a single merchant document.
 * - Reads all locations
 * - Reads full catalog
 * - Reads all inventory counts per location (paginated)
 * - Writes to:
 *   - inventory (master)
 *   - merchants/{merchantId}/inventory (per-merchant)
 */
async function syncMerchantInventory(merchantDoc) {
  const data = merchantDoc.data();
  const merchantId = merchantDoc.id;

  console.log(`Syncing inventory for merchant ${merchantId} (${data.business_name})`);

  const client = createSquareClient(data.access_token, data.env || 'sandbox');

  // 1) Build catalog lookup tables
  const { itemsById, variationsById, categoriesById, taxesById } =
    await buildCatalogMaps(client);

  // 2) Get locations for this merchant
  const locationsRes = await client.locationsApi.listLocations();
  const locations = locationsRes.result.locations || [];
  console.log(`Found ${locations.length} locations for merchant ${merchantId}`);

  // 3) For each location, pull inventory counts
  for (const loc of locations) {
    console.log(`Syncing inventory for location ${loc.id} (${loc.name})`);

    let cursor = undefined;
    let loops = 0;

    do {
      const invRes = await client.inventoryApi.batchRetrieveInventoryCounts({
        locationIds: [loc.id],
        cursor,
      });

      const counts = invRes.result.counts || [];
      cursor = invRes.result.cursor;

      console.log(
        `Fetched ${counts.length} counts for location ${loc.id}, cursor=${cursor}`
      );

      const batch = firestore.batch();

      for (const c of counts) {
        const variation = variationsById[c.catalogObjectId];
        const parentItemId = variation?.itemVariationData?.itemId;
        const parentItem = parentItemId ? itemsById[parentItemId] : null;

        const sku = variation?.itemVariationData?.sku || null;
        const gtin = variation?.itemVariationData?.upc || null; // GTIN / UPC
        const itemName = parentItem?.itemData?.name || 'Unknown';
        const variationName = variation?.itemVariationData?.name || null;

        // --- CATEGORY RESOLUTION ---
        // 1) Legacy single categoryId
        let primaryCategoryId = parentItem?.itemData?.categoryId || null;

        // 2) New-style categories[] (CatalogObjectReference list)
        if (!primaryCategoryId && parentItem?.itemData?.categories?.length) {
          // Take the first category as "primary" for now
          primaryCategoryId = parentItem.itemData.categories[0].id;
        }

        const categoryId = primaryCategoryId;
        const categoryName =
          categoryId && categoriesById[categoryId]
            ? categoriesById[categoryId].categoryData?.name || null
            : null;
    
        const taxIds = parentItem?.itemData?.taxIds || [];
        const taxNames = taxIds
          .map((id) => taxesById[id]?.taxData?.name)
          .filter(Boolean);
        const taxPercentages = taxIds
          .map((id) => taxesById[id]?.taxData?.percentage)
          .filter(Boolean);

        // Retail price (base price on variation)
        const priceMoney = variation?.itemVariationData?.priceMoney || null;
        const price = priceMoney ? Number(priceMoney.amount) / 100 : null;
        const currency = priceMoney?.currency || null;

        const docId = `${merchantId}_${loc.id}_${c.catalogObjectId}_${c.state}`;

        const payload = {
          merchant_id: merchantId,
          merchant_name: data.business_name,
          location_id: loc.id,
          location_name: loc.name,
          catalog_object_id: c.catalogObjectId,
          item_id: parentItemId || null,
          variation_id: variation?.id || null,

          item_name: itemName,
          variation_name: variationName,
          sku,
          gtin,
          category_id: categoryId,
          category_name: categoryName,

          tax_ids: taxIds,
          tax_names: taxNames,
          tax_percentages: taxPercentages,

          price,
          currency,

          qty: parseFloat(c.quantity),
          state: c.state,
          calculated_at: c.calculatedAt,
          updated_at: new Date().toISOString(),
        };

        // 1) Master inventory collection
        const masterRef = firestore.collection('inventory').doc(docId);
        batch.set(masterRef, payload, { merge: true });

        // 2) Per-merchant inventory subcollection
        const merchantInvRef = firestore
          .collection('merchants')
          .doc(merchantId)
          .collection('inventory')
          .doc(docId);
        batch.set(merchantInvRef, payload, { merge: true });
      }

      await batch.commit();
      loops++;
    } while (cursor && loops < 50); // safety cap

    console.log(`Finished location ${loc.id} for merchant ${merchantId}`);
  }

  console.log(`Done syncing inventory for merchant ${merchantId}`);
}

/**
 * Sync inventory for all merchants currently in Firestore.
 */
async function syncAllMerchants() {
  console.log('Starting syncAllMerchants()');

  const snapshot = await firestore.collection('merchants').get();
  console.log(`Found ${snapshot.size} merchants`);

  for (const doc of snapshot.docs) {
    try {
      await syncMerchantInventory(doc);
    } catch (err) {
      console.error(`Failed to sync merchant ${doc.id}`, err);
    }
  }

  console.log('Finished syncAllMerchants()');
}

module.exports = { syncAllMerchants };
