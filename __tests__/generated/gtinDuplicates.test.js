const express = require('express');
const request = require('supertest');
const buildRouter = require('../../routes/gtinDuplicates');

// Helper to build a fake Firestore
function makeFirestore({ merchantExists = true, merchantData = {}, matrixPages = [] } = {}) {
  return {
    collection: (name) => {
      if (name === 'merchants') {
        return {
          doc: (id) => ({
            get: async () => {
              if (!merchantExists) return { exists: false };
              return { exists: true, data: () => merchantData };
            },
          }),
        };
      }

      if (name === 'gtin_inventory_matrix') {
        // Create pages of docs. Each page is an array of { id, data }
        const pages = matrixPages.map((page, idx) =>
          page.map((d) => ({ id: d.id, _data: d.data, _pageIndex: idx }))
        );

        function createQuery() {
          let pointer = 0;
          return {
            limit() {
              // ignore limit, pages already prepared
              return this;
            },
            startAfter(lastDoc) {
              if (lastDoc && typeof lastDoc._pageIndex === 'number') {
                pointer = lastDoc._pageIndex + 1;
              }
              return this;
            },
            orderBy() {
              return this;
            },
            async get() {
              const docsRaw = pointer < pages.length ? pages[pointer] : [];
              const docs = docsRaw.map((r) => ({
                id: r.id,
                data: () => r._data,
                // keep the page index on the object so startAfter can inspect it
                _pageIndex: r._pageIndex,
              }));
              pointer += 1; // next get() will move to next page
              return { empty: docs.length === 0, docs };
            },
          };
        }

        return { orderBy: () => createQuery() };
      }

      // default stub for other collections
      return {
        doc: () => ({ get: async () => ({ exists: false }) }),
      };
    },
  };
}

describe('routes/gtinDuplicates', () => {
  test('returns 400 when merchantId missing', async () => {
    const firestore = makeFirestore();
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/gtin-duplicates');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'merchantId is required');
    expect(requireLogin).toHaveBeenCalled();
  });

  test('returns 404 when merchant not found', async () => {
    const firestore = makeFirestore({ merchantExists: false });
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/gtin-duplicates').query({ merchantId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Merchant nope not found');
    expect(requireLogin).toHaveBeenCalled();
  });

  test('finds duplicate GTINs across locations and sorts by count desc', async () => {
    const merchantId = 'm1';
    const merchantData = { business_name: 'Test Merchant' };

    // Build matrix pages:
    // page 1: docA (gtin present in two locations for m1), docB (no hits)
    // page 2: docC (gtin present in three locations for m1)

    const docA = {
      id: 'A',
      data: {
        gtin: 'GTIN-A',
        item_name: 'Item A',
        sku: 'SKU-A',
        category_name: 'Cat A',
        pricesByLocation: {
          loc1: { merchant_id: merchantId, location_id: 'L1', location_name: 'Loc 1', price: 9.99, item_name: 'Item A loc', sku: 'SKU-A1' },
          loc2: { merchant_id: merchantId, location_id: 'L2', location_name: 'Loc 2', price: 10.5, item_name: 'Item A loc', sku: 'SKU-A2' },
          other: { merchant_id: 'other', location_id: 'X', location_name: 'Other', price: 8.0 },
        },
      },
    };

    const docB = {
      id: 'B',
      data: {
        gtin: 'GTIN-B',
        pricesByLocation: {
          loc1: { merchant_id: 'other' },
        },
      },
    };

    const docC = {
      id: 'C',
      data: {
        // no explicit gtin, should fall back to doc.id
        item_name: 'Item C',
        sku: 'SKU-C',
        pricesByLocation: {
          l1: { merchant_id: merchantId, location_id: 'L1', location_name: 'Loc 1', price: 5 },
          l2: { merchant_id: merchantId, location_id: 'L2', location_name: 'Loc 2', price: 6 },
          l3: { merchant_id: merchantId, location_id: 'L3', location_name: 'Loc 3', price: 7 },
        },
      },
    };

    const firestore = makeFirestore({
      merchantExists: true,
      merchantData,
      matrixPages: [[docA, docB], [docC]],
    });

    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildRouter({ firestore, requireLogin }));

    const res = await request(app)
      .get('/api/gtin-duplicates')
      .query({ merchantId, top: 10, maxDocs: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('merchantId', merchantId);
    expect(res.body).toHaveProperty('merchantName', merchantData.business_name);
    expect(res.body).toHaveProperty('source', 'gtin_inventory_matrix');
    // scannedMatrixDocs should equal total docs scanned (3)
    expect(res.body).toHaveProperty('scannedMatrixDocs', 3);
    expect(res.body).toHaveProperty('duplicateGtins', 2);
    expect(Array.isArray(res.body.dupes)).toBe(true);
    expect(res.body.dupes).toHaveLength(2);

    // Should be sorted by count descending: docC (3) then docA (2)
    expect(res.body.dupes[0].gtin).toBe('C'); // doc.id used as gtin when no explicit gtin
    expect(res.body.dupes[0].count).toBe(3);
    expect(res.body.dupes[1].gtin).toBe('GTIN-A');
    expect(res.body.dupes[1].count).toBe(2);

    expect(requireLogin).toHaveBeenCalled();
  });

  test('returns 500 when processing throws', async () => {
    const merchantId = 'm1';
    const merchantData = { business_name: 'Test Merchant' };

    // Firestore where matrix.get() throws
    const firestore = {
      collection: (name) => {
        if (name === 'merchants') {
          return { doc: () => ({ get: async () => ({ exists: true, data: () => merchantData }) }) };
        }
        if (name === 'gtin_inventory_matrix') {
          return {
            orderBy: () => ({ limit: () => ({ startAfter: () => ({ get: async () => { throw new Error('boom-matrix'); } }) }) }),
          };
        }
        return { doc: () => ({ get: async () => ({ exists: false }) }) };
      },
    };

    const requireLogin = jest.fn((req, res, next) => next());
    const app = express();
    app.use(buildRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/gtin-duplicates').query({ merchantId });
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(String(res.body.error).toLowerCase()).toContain('boom');
    expect(requireLogin).toHaveBeenCalled();
  });
});
