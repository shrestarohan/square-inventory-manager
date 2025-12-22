require("../lib/loadEnv"); // adjust relative path
const firestore = require('../lib/firestore');

function safeLower(v) {
  const s = (v ?? '').toString().trim();
  return s ? s.toLowerCase() : null;
}

function toMillis(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

function mergeAgg(agg, row) {
  // qty rule: sum only IN_STOCK (change if you want all states)
  const qty = row.state === 'IN_STOCK' ? Number(row.qty || 0) : 0;
  agg.qty = (agg.qty || 0) + qty;

  // pick “best” row by latest calculated_at (for price/name/category/images)
  const rowTs = toMillis(row.calculated_at || row.updated_at);
  const aggTs = toMillis(agg.calculated_at || agg.updated_at);

  const rowHasPrice = row.price != null;
  const aggHasPrice = agg.price != null;

  const shouldReplace =
    rowTs > aggTs ||
    (!aggHasPrice && rowHasPrice);

  if (shouldReplace) {
    // keep core display fields from the latest/best row
    agg.item_name = row.item_name || agg.item_name || '';
    agg.item_name_lc = safeLower(agg.item_name);

    agg.category_name = row.category_name || agg.category_name || null;
    agg.category_name_lc = safeLower(agg.category_name);

    agg.sku = row.sku || agg.sku || null;
    agg.sku_lc = safeLower(agg.sku);

    agg.price = row.price ?? agg.price ?? null;
    agg.currency = row.currency ?? agg.currency ?? null;

    agg.image_urls = Array.isArray(row.image_urls) ? row.image_urls : (row.image_urls ? [row.image_urls] : []);
    agg.tax_names = Array.isArray(row.tax_names) ? row.tax_names : [];
    agg.tax_percentages = Array.isArray(row.tax_percentages) ? row.tax_percentages : [];

    agg.calculated_at = row.calculated_at || agg.calculated_at || null;
  }

  // always keep these
  agg.merchant_id = row.merchant_id;
  agg.merchant_name = row.merchant_name || agg.merchant_name || null;
  agg.merchant_name_lc = safeLower(agg.merchant_name);

  agg.location_id = row.location_id;
  agg.location_name = row.location_name || agg.location_name || null;
  agg.location_name_lc = safeLower(agg.location_name);

  agg.gtin = row.gtin;
  agg.updated_at = new Date().toISOString();

  // optional: track which variations contributed
  if (!agg.variation_ids) agg.variation_ids = [];
  if (row.variation_id && !agg.variation_ids.includes(row.variation_id)) {
    agg.variation_ids.push(row.variation_id);
  }

  return agg;
}

async function main() {
  const SOURCE = firestore.collection('inventory'); // master raw
  const DEST = firestore.collection('inventory_loc_gtin');

  const pageSize = 1000;

  let lastDoc = null;
  let totalRead = 0;
  let totalWritten = 0;

  // use BulkWriter for speed + fewer batch headaches
  const writer = firestore.bulkWriter();

  // in-memory aggregation per page; flush each page so memory stays low
  while (true) {
    let q = SOURCE.orderBy('__name__').limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    const aggMap = new Map();

    for (const doc of snap.docs) {
      const row = doc.data();
      if (!row.gtin || !row.location_id || !row.merchant_id) continue;

      const key = `${row.merchant_id}__${row.location_id}__${row.gtin}`;
      const existing = aggMap.get(key) || {};
      aggMap.set(key, mergeAgg(existing, row));
    }

    // write aggregated docs
    for (const [key, agg] of aggMap.entries()) {
      const docId = key.replace(/__/g, '_'); // merchant_location_gtin
      writer.set(DEST.doc(docId), agg, { merge: true });
      totalWritten++;
    }

    totalRead += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];

    console.log(`Read ${totalRead} raw docs, wrote ~${totalWritten} agg docs so far...`);
  }

  await writer.close();
  console.log(`DONE. Read ${totalRead} raw docs. Wrote ${totalWritten} aggregated docs.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
