const request = require('supertest');
const express = require('express');
const router = require('../../routes/reorderRoutes');

// Helpers to build fake Firestore responses
function makeDoc(id, data) {
  return {
    id,
    data: () => data,
  };
}

function makeGetResult(docs = []) {
  return {
    docs,
    forEach(fn) {
      for (const d of docs) fn(d);
    },
  };
}

function makeFakeFirestore({
  inventorySnapshotDocs = [],
  merchantInventoryDocs = [],
  salesDailyDocs = [],
  reorderSettings = {},
} = {}) {
  // collection(name) returns an object that can be chained with where/limit/get/select/doc(...)
  const collections = new Map();

  collections.set('inventory_snapshot', {
    get: async () => makeGetResult(inventorySnapshotDocs),
  });

  // merchants collection -> doc(mid) -> collection('inventory') -> where/select/limit/get
  const merchantsColl = {
    doc: (mid) => ({
      collection: (name) => ({
        where() { return this; },
        select() { return this; },
        limit() { return this; },
        get: async () => makeGetResult(merchantInventoryDocs),
      }),
    }),
  };
  collections.set('merchants', merchantsColl);

  collections.set('sales_daily', {
    get: async () => makeGetResult(salesDailyDocs),
  });

  const reorderColl = {
    doc: (id) => ({
      get: async () => {
        const doc = reorderSettings[id];
        if (!doc) return { exists: false };
        return { exists: true, data: () => doc };
      },
    }),
  };
  collections.set('reorder_settings', reorderColl);

  // Generic collection function
  return {
    collection(name) {
      const c = collections.get(name);
      if (!c) {
        // return a generic chainable object that resolves to empty
        return {
          where() { return this; },
          limit() { return this; },
          select() { return this; },
          get: async () => makeGetResult([]),
          doc: () => ({ get: async () => ({ exists: false }) }),
        };
      }

      // If c already implements chain methods, wrap accordingly
      if (name === 'inventory_snapshot') {
        return {
          where() { return this; },
          limit() { return this; },
          get: c.get,
        };
      }

      if (name === 'merchants') return c;

      if (name === 'sales_daily') {
        return {
          where() { return this; },
          limit() { return this; },
          get: c.get,
          forEach: () => {},
        };
      }

      if (name === 'reorder_settings') return c;

      return {
        where() { return this; },
        limit() { return this; },
        get: async () => makeGetResult([]),
      };
    },
  };
}

describe('GET /api/reorder router', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(router);
  });

  test('returns 400 when merchantId or locationId missing', async () => {
    const res = await request(app).get('/api/reorder');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('ok', false);
    expect(res.body).toHaveProperty('error');
  });

  test('computes reorder rows from inventory_snapshot + sales_daily + reorder_settings', async () => {
    // Prepare data
    // Two variations: v1 has sales, v2 has no sales and zero on_hand
    const invDocs = [
      makeDoc('s1', {
        variation_id: 'v1',
        item_name: 'Item One',
        sku: 'SKU1',
        gtin: 'GTIN1',
        on_hand: 2,
        location_name: 'Loc1',
      }),
      makeDoc('s2', {
        variation_id: 'v2',
        item_name: 'Item Two',
        sku: 'SKU2',
        gtin: 'GTIN2',
        on_hand: 0,
        location_name: 'Loc1',
      }),
    ];

    // sales_daily: v1 sold 10 units across window
    const salesDocs = [
      makeDoc('d1', { variation_id: 'v1', qty_sold: 10, day: '2020-01-01' }),
    ];

    // reorder settings for v1: lead 3 safety 2 pack 5 unit_cost 2.5
    const settingsIdV1 = 'm1|l1|v1';
    const reorderSettings = {};
    reorderSettings[settingsIdV1] = {
      lead_time_days: 3,
      safety_days: 2,
      pack_size: 5,
      min_qty: 0,
      unit_cost: 2.5,
      vendor: 'Acme',
    };

    const firestore = makeFakeFirestore({
      inventorySnapshotDocs: invDocs,
      salesDailyDocs: salesDocs,
      reorderSettings,
    });

    app.locals.firestore = firestore;

    const res = await request(app)
      .get('/api/reorder')
      .query({ merchantId: 'm1', locationId: 'l1', days: '10' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.merchantId).toBe('m1');
    expect(res.body.locationId).toBe('l1');
    expect(res.body.days).toBe(10);
    expect(Array.isArray(res.body.rows)).toBe(true);

    const rows = res.body.rows;
    // v2 has days_cover 0 and should come first
    expect(rows.length).toBe(2);

    const first = rows[0];
    expect(first.variation_id).toBe('v2');
    expect(first.days_cover).toBe(0);
    expect(first.reorder_qty).toBe(0);

    const second = rows[1];
    expect(second.variation_id).toBe('v1');
    // on_hand 2, sold 10 over 10 days => avgDaily = 1.0
    expect(second.avg_daily_sales).toBe(1); // rounded to 3 decimals but integer 1
    // target = 1 * (3 + 2) =5, reorder = 5 - 2 = 3 => ceilToPack with pack 5 => 5
    expect(second.reorder_qty).toBe(5);
    expect(second.unit_cost).toBe(2.5);
    // est_cost = 2.5 * 5 = 12.5
    expect(second.est_cost).toBe(12.5);
    expect(second.vendor).toBe('Acme');
    expect(typeof second.generated_at).toBe('string');
    // generated_at should be ISO-ish
    expect(new Date(second.generated_at).toString()).not.toBe('Invalid Date');
  });

  test('falls back to merchants/{id}/inventory when inventory_snapshot is empty and skips dead items with positive on_hand', async () => {
    // inventory_snapshot empty
    const invDocs = [];

    // merchant inventory contains two items:
    // v3: on_hand 5 but zero sales -> should be skipped (dead item with positive on_hand)
    // v4: on_hand 0 and zero sales -> should be included (avgDaily 0 and on_hand 0)
    const merchantInv = [
      makeDoc('i1', {
        variation_id: 'v3',
        item_name: 'Item Three',
        sku: 'SKU3',
        gtin: 'GTIN3',
        qty: 5,
        location_name: 'Loc1',
      }),
      makeDoc('i2', {
        variation_id: 'v4',
        item_name: 'Item Four',
        sku: 'SKU4',
        gtin: 'GTIN4',
        qty: 0,
        location_name: 'Loc1',
      }),
    ];

    // no sales docs
    const salesDocs = [];

    const firestore = makeFakeFirestore({
      inventorySnapshotDocs: invDocs,
      merchantInventoryDocs: merchantInv,
      salesDailyDocs: salesDocs,
      reorderSettings: {},
    });

    app.locals.firestore = firestore;

    const res = await request(app)
      .get('/api/reorder')
      .query({ merchantId: 'm1', locationId: 'l1', days: '14' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = res.body.rows;
    // v3 should be skipped because avgDaily=0 and on_hand>0
    // v4 should be included (on_hand=0, avgDaily=0)
    expect(rows.find(r => r.variation_id === 'v3')).toBeUndefined();
    const v4 = rows.find(r => r.variation_id === 'v4');
    expect(v4).toBeDefined();
    expect(v4.on_hand).toBe(0);
    expect(v4.reorder_qty).toBe(0);
  });
});
