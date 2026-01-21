// scripts/syncSalesDaily.js
require("../lib/loadEnv"); // adjust relative path

const firestore = require('../lib/firestore');
const { createSquareClient } = require('../lib/squareClient');

function isoDay(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Simple numeric parse for Square lineItem quantity strings
function nQty(q) {
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

// searchOrders pagination helper
async function* searchOrdersAll(client, { locationId, startAtIso, endAtIso }) {
  let cursor = undefined;

  while (true) {
    const body = {
      locationIds: [locationId],
      query: {
        filter: {
          stateFilter: { states: ['COMPLETED'] },
          dateTimeFilter: {
            // ClosedAt is ideal; if missing in your data, switch to createdAt
            closedAt: { startAt: startAtIso, endAt: endAtIso },
          },
        },
        sort: { sortField: 'CLOSED_AT', sortOrder: 'ASC' },
      },
      cursor,
      limit: 500,
    };

    const resp = await client.ordersApi.searchOrders(body);
    const result = resp.result || {};
    const orders = result.orders || [];
    for (const o of orders) yield o;

    cursor = result.cursor;
    if (!cursor) break;
  }
}

async function syncSalesDailyForMerchant({ merchantId, days = 28 }) {
  const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
  if (!merchantDoc.exists) throw new Error(`Merchant not found: ${merchantId}`);
  const merchant = merchantDoc.data();

  const client = createSquareClient(merchant.access_token, merchant.env || 'production');

  // You likely already have location_index; easiest is pull from Square:
  const locRes = await client.locationsApi.listLocations();
  const locations = (locRes.result?.locations || []).filter(l => l.status === 'ACTIVE');

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const startAtIso = start.toISOString();
  const endAtIso = end.toISOString();

  for (const loc of locations) {
    const locationId = loc.id;
    const locationName = loc.name || locationId;

    // Aggregate: day -> variationId -> { qty_sold, gross_sales }
    const agg = new Map(); // key = `${day}|${variationId}`

    for await (const order of searchOrdersAll(client, { locationId, startAtIso, endAtIso })) {
      const day = isoDay(new Date(order.closedAt || order.createdAt || Date.now()));
      const lineItems = order.lineItems || [];

      for (const li of lineItems) {
        const variationId = li.catalogObjectId; // variation id
        if (!variationId) continue;

        const qty = nQty(li.quantity);
        if (qty <= 0) continue;

        // Gross sales (best-effort)
        const grossMoney = li.grossSalesMoney || li.totalMoney || null;
        const gross = grossMoney?.amount != null ? Number(grossMoney.amount) / 100 : 0;

        const key = `${day}|${variationId}`;
        const cur = agg.get(key) || { qty_sold: 0, gross_sales: 0 };
        cur.qty_sold += qty;
        cur.gross_sales += gross;
        agg.set(key, cur);
      }
    }

    // Write to Firestore in batches
    const entries = Array.from(agg.entries());
    const chunkSize = 400;

    for (let i = 0; i < entries.length; i += chunkSize) {
      const batch = firestore.batch();
      const slice = entries.slice(i, i + chunkSize);

      for (const [key, v] of slice) {
        const [day, variationId] = key.split('|');
        const docId = `${merchantId}|${locationId}|${variationId}|${day}`;

        const ref = firestore.collection('sales_daily').doc(docId);
        batch.set(ref, {
          merchant_id: merchantId,
          merchant_name: merchant.business_name || merchantId,
          location_id: locationId,
          location_name: locationName,
          variation_id: variationId,
          day,
          qty_sold: v.qty_sold,
          gross_sales: Math.round(v.gross_sales * 100) / 100,
          updated_at: new Date().toISOString(),
        }, { merge: true });
      }

      await batch.commit();
    }
  }

  return { ok: true, merchantId, days };
}

module.exports = { syncSalesDailyForMerchant };
