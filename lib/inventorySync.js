// lib/inventorySync.js
const { Client, Environment } = require('square/legacy');
const firestore = require('../lib/firestore');

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
 * Lowercase helper (returns null if empty)
 */
function toLowerOrNull(v) {
  const s = (v ?? '').toString().trim();
  return s ? s.toLowerCase() : null;
}

/**
 * Build full catalog lookup maps.
 */
async function buildCatalogMaps(client) {
  const itemsById = {};
  const variationsById = {};
  const categoriesById = {};
  const taxesById = {};
  const imagesById = {};

  let cursor = undefined;
  let page = 0;

  do {
    const res = await client.catalogApi.listCatalog(
      cursor,
      'ITEM,ITEM_VARIATION,CATEGORY,TAX,IMAGE'
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
        case 'IMAGE':
          imagesById[obj.id] = obj;
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
      `taxes=${Object.keys(taxesById).length}, ` +
      `images=${Object.keys(imagesById).length}`
  );

  return { itemsById, variationsById, categoriesById, taxesById, imagesById };
}

/**
 * Sync inventory for a single merchant document.
 */
async function syncMerchantInventory(merchantDoc) {
  const data = merchantDoc.data();
  const merchantId = merchantDoc.id;

  console.log(`Syncing inventory for merchant ${merchantId} (${data.business_name})`);

  const client = createSquareClient(data.access_token, data.env || 'sandbox');

  // 1) Catalog lookup tables
  const { itemsById, variationsById, categoriesById, taxesById, imagesById } =
    await buildCatalogMaps(client);

  // 2) Locations
  const locationsRes = await client.locationsApi.listLocations();
  const locations = locationsRes.result.locations || [];
  console.log(`Found ${locations.length} locations for merchant ${merchantId}`);

  // Firestore batch safety:
  // Each "count" writes TWO docs (master + merchant subcollection).
  // Firestore limit is 500 writes/batch -> keep well below.
  const MAX_WRITES_PER_BATCH = 450;

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

      console.log(`Fetched ${counts.length} counts for location ${loc.id}, cursor=${cursor}`);

      let batch = firestore.batch();
      let writes = 0;

      async function flush() {
        if (writes === 0) return;
        await batch.commit();
        batch = firestore.batch();
        writes = 0;
      }

      for (const c of counts) {
        const variation = variationsById[c.catalogObjectId];
        const parentItemId = variation?.itemVariationData?.itemId;
        const parentItem = parentItemId ? itemsById[parentItemId] : null;

        const sku = variation?.itemVariationData?.sku || null;

        // Square calls it "upc" in itemVariationData; you store as gtin.
        const gtin = variation?.itemVariationData?.upc || null;

        const itemName = parentItem?.itemData?.name || 'Unknown';
        const variationName = variation?.itemVariationData?.name || null;

        // CATEGORY RESOLUTION
        let primaryCategoryId = parentItem?.itemData?.categoryId || null;
        if (!primaryCategoryId && parentItem?.itemData?.categories?.length) {
          primaryCategoryId = parentItem.itemData.categories[0].id;
        }

        const categoryId = primaryCategoryId;
        const categoryName =
          categoryId && categoriesById[categoryId]
            ? categoriesById[categoryId].categoryData?.name || null
            : null;

        // Taxes
        const taxIds = parentItem?.itemData?.taxIds || [];
        const taxNames = taxIds
          .map((id) => taxesById[id]?.taxData?.name)
          .filter(Boolean);
        const taxPercentages = taxIds
          .map((id) => taxesById[id]?.taxData?.percentage)
          .filter(Boolean);

        // Price
        const priceMoney = variation?.itemVariationData?.priceMoney || null;
        const price = priceMoney ? Number(priceMoney.amount) / 100 : null;
        const currency = priceMoney?.currency || null;

        // Images
        const imageIds = parentItem?.itemData?.imageIds || [];
        const imageUrls = imageIds
          .map((id) => imagesById[id]?.imageData?.url || null)
          .filter(Boolean);

        const docId = `${merchantId}_${loc.id}_${c.catalogObjectId}_${c.state}`;

        const nowIso = new Date().toISOString();

        const payload = {
          merchant_id: merchantId,
          merchant_name: data.business_name,
          merchant_name_lc: toLowerOrNull(data.business_name),

          location_id: loc.id,
          location_name: loc.name,
          location_name_lc: toLowerOrNull(loc.name),

          catalog_object_id: c.catalogObjectId,
          item_id: parentItemId || null,
          variation_id: variation?.id || null,

          item_name: itemName,
          item_name_lc: toLowerOrNull(itemName),

          variation_name: variationName,

          sku,
          sku_lc: toLowerOrNull(sku),

          gtin,

          category_id: categoryId,
          category_name: categoryName,
          category_name_lc: toLowerOrNull(categoryName),

          tax_ids: taxIds,
          tax_names: taxNames,
          tax_percentages: taxPercentages,

          price,
          currency,

          image_ids: imageIds,
          image_urls: imageUrls,

          qty: c.quantity != null ? parseFloat(c.quantity) : 0,
          state: c.state,
          calculated_at: c.calculatedAt,
          updated_at: nowIso,
        };

        // Master inventory
        const masterRef = firestore.collection('inventory').doc(docId);
        batch.set(masterRef, payload, { merge: true });
        writes++;

        // Per-merchant inventory
        const merchantInvRef = firestore
          .collection('merchants')
          .doc(merchantId)
          .collection('inventory')
          .doc(docId);

        batch.set(merchantInvRef, payload, { merge: true });
        writes++;

        // Flush if near batch limit
        if (writes >= MAX_WRITES_PER_BATCH) {
          await flush();
        }
      }

      // final flush for this page
      await flush();

      loops++;
    } while (cursor && loops < 50);

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

module.exports = {
  syncAllMerchants,
  syncMerchantInventory,
  createSquareClient,
  buildCatalogMaps,
};
