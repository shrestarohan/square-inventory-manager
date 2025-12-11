// lib/squareCatalog.js
const { Client, Environment } = require('square/legacy');

const squareClient = new Client({
  environment: process.env.SQUARE_ENV === 'production'
    ? Environment.Production
    : Environment.Sandbox,
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

async function fetchAllCatalogVariations() {
  const { catalogApi } = squareClient;

  let cursor = undefined;
  const variations = [];

  do {
    const res = await catalogApi.listCatalog(cursor, 'ITEM,ITEM_VARIATION');
    const objects = res.result.objects || [];
    for (const obj of objects) {
      if (obj.type === 'ITEM_VARIATION' && obj.itemVariationData) {
        variations.push(obj);
      }
    }
    cursor = res.result.cursor;
  } while (cursor);

  return variations;
}

async function buildGtinToVariationMap() {
  const variations = await fetchAllCatalogVariations();
  const map = new Map();

  for (const v of variations) {
    const gtin = v.itemVariationData.upc || null;
    if (!gtin) continue;
    // If multiple variations share same GTIN, you might want an array instead
    map.set(gtin, v);
  }

  return map;
}

module.exports = {
  squareClient,
  fetchAllCatalogVariations,
  buildGtinToVariationMap,
};
