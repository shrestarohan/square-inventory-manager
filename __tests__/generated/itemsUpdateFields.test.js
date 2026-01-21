const express = require('express');
const request = require('supertest');

// We'll mock ../lib/square by resolving its absolute path so the module loaded by the
// route file is the same module Jest replaces.
let currentSquareHandlers = {};
function setSquareHandlers(h) {
  currentSquareHandlers = h || {};
}

// Build a simple Firestore-like mock used by the route. It only implements the
// functionality the route uses: collection(...).doc(...).collection(...).where(...).get()
// and firestore.batch().commit()/set(). We allow tests to provide merchant/global docs.
function makeFirestoreMock({ merchantInventoryDocs = [], globalInventoryDocs = [] } = {}) {
  const db = {
    _merchantDocs: merchantInventoryDocs,
    _globalDocs: globalInventoryDocs,
  };

  function makeCollection(name) {
    if (name === 'merchants') {
      return {
        doc: (merchantId) => ({
          collection: (colName) => {
            if (colName !== 'inventory') throw new Error('unknown subcollection');
            const invDocs = db._merchantDocs.map((p, i) => ({
              ref: { path: `merchants/${merchantId}/inventory/doc${i}` },
              data: () => p,
            }));
            return {
              where: (field, op, val) => {
                // Only equality used
                const docs = invDocs.filter((d) => d.data()[field] === val);
                return Promise.resolve({ docs });
              },
            };
          },
        }),
      };
    }

    if (name === 'inventory') {
      const invDocs = db._globalDocs.map((p, i) => ({
        ref: { path: `inventory/doc${i}` },
        data: () => p,
      }));
      return {
        where: (field, op, val) => {
          const docs = invDocs.filter((d) => d.data()[field] === val);
          return Promise.resolve({ docs });
        },
      };
    }

    // default empty collection
    return { where: () => Promise.resolve({ docs: [] }) };
  }

  function batchFactory() {
    const sets = [];
    return {
      set: (ref, patch, opts) => {
        sets.push({ ref: ref.path, patch, opts });
      },
      commit: () => Promise.resolve(sets),
    };
  }

  return {
    collection: makeCollection,
    batch: batchFactory,
  };
}

// Helper to create the Express app with the router under test. We must mock
// the square module before requiring the router module so its require() picks up our mock.
async function createApp({ firestoreMock, requireLogin = (req, res, next) => { req.user = { email: 'test@x.com', id: 'u1' }; next(); } } = {}) {
  jest.resetModules();

  // Resolve the absolute path to lib/square and mock it so the router's require() obtains
  // our implementation. The factory returns a function that returns a square client
  // whose catalogApi methods delegate to currentSquareHandlers.
  const squareModulePath = require.resolve('../../lib/square');
  jest.doMock(squareModulePath, () => ({
    makeCreateSquareClientForMerchant: ({ firestore }) => {
      // The route calls makeCreateSquareClientForMerchant({ firestore }) and later
      // calls the returned function with { merchantId }.
      return async ({ merchantId }) => {
        return {
          catalogApi: {
            retrieveCatalogObject: async (id, inc) => {
              if (typeof currentSquareHandlers.retrieveCatalogObject === 'function') {
                return currentSquareHandlers.retrieveCatalogObject(id, merchantId);
              }
              return { result: {} };
            },
            upsertCatalogObject: async (body) => {
              if (typeof currentSquareHandlers.upsertCatalogObject === 'function') {
                return currentSquareHandlers.upsertCatalogObject(body, merchantId);
              }
              return { result: {} };
            },
          },
        };
      };
    },
  }));

  // Now require the router after mocking
  const buildRouter = require('../../routes/itemsUpdateFields');
  const router = buildRouter({ firestore: firestoreMock, requireLogin });

  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('POST /api/items/update-fields', () => {
  test('validations: missing merchantId/itemId/updates/no supported fields', async () => {
    const firestore = makeFirestoreMock();
    setSquareHandlers({});
    const app = await createApp({ firestoreMock: firestore });

    // missing merchantId
    let res = await request(app).post('/api/items/update-fields').send({ itemId: 'I1', updates: { item_name: 'A' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing merchantId/);

    // missing itemId
    res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M1', updates: { item_name: 'A' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing itemId/);

    // missing updates (not object)
    res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M1', itemId: 'I1', updates: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing updates object/);

    // no supported fields
    res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M1', itemId: 'I1', updates: { foo: 'bar' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No supported fields/);
  });

  test('price validation: non-number and negative', async () => {
    const firestore = makeFirestoreMock();
    setSquareHandlers({});
    const app = await createApp({ firestoreMock: firestore });

    // non-number price -> 400 Price must be a number
    let res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M', itemId: 'I', variationId: 'V', updates: { price: 'not-a-number' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Price must be a number/);

    // negative price -> 400 Price cannot be negative
    res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M', itemId: 'I', variationId: 'V', updates: { price: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Price cannot be negative/);
  });

  test('gtin normalization error returns 500 with message from thrown Error', async () => {
    const firestore = makeFirestoreMock();
    setSquareHandlers({});
    const app = await createApp({ firestoreMock: firestore });

    const res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M', itemId: 'I', variationId: 'V', updates: { gtin: 'ABC123' } });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/GTIN must be digits only/);
  });

  test('requires variationId when updating sku/gtin/price', async () => {
    const firestore = makeFirestoreMock();
    setSquareHandlers({});
    const app = await createApp({ firestoreMock: firestore });

    const res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M', itemId: 'I', updates: { sku: 'S1' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/variationId is required/);
  });

  test('square ITEM not found returns 404', async () => {
    const firestore = makeFirestoreMock();

    setSquareHandlers({
      retrieveCatalogObject: async (id) => ({ result: { object: null } }),
    });

    const app = await createApp({ firestoreMock: firestore });

    const res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M', itemId: 'I-MISSING', updates: { item_name: 'New name' } });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Square ITEM not found/);
  });

  test('square upsert errors for ITEM propagate as 400 with squareErrors', async () => {
    const firestore = makeFirestoreMock();

    setSquareHandlers({
      retrieveCatalogObject: async (id) => ({ result: { object: { type: 'ITEM', version: 5, itemData: { name: 'old' } } } }),
      upsertCatalogObject: async (body) => ({ result: { errors: [{ category: 'INVALID', detail: 'bad' }] } }),
    });

    const app = await createApp({ firestoreMock: firestore });

    const res = await request(app).post('/api/items/update-fields').send({ merchantId: 'M', itemId: 'I1', updates: { item_name: 'New' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Square upsert \(ITEM\) returned errors/);
    expect(res.body.squareErrors).toBeDefined();
    expect(Array.isArray(res.body.squareErrors)).toBe(true);
  });

  test('successful item + variation update updates Firestore counts and returns applied normalized fields', async () => {
    // Prepare some fake docs so that merchant inventory returns two docs (one matching item, one matching variation)
    const merchantDocs = [
      { item_id: 'ITEM123', variation_id: 'VAR1', foo: 'a' },
      { item_id: 'OTHER', variation_id: 'VAR1', foo: 'b' },
    ];
    // global inventory has one doc matching item
    const globalDocs = [
      { item_id: 'ITEM123', variation_id: 'VARX' },
    ];

    const firestore = makeFirestoreMock({ merchantInventoryDocs: merchantDocs, globalInventoryDocs: globalDocs });

    setSquareHandlers({
      retrieveCatalogObject: async (id, merchantId) => {
        if (id === 'ITEM123') {
          return { result: { object: { type: 'ITEM', version: 10n, itemData: { name: 'Old name' } } } };
        }
        if (id === 'VAR1') {
          return { result: { object: { type: 'ITEM_VARIATION', version: 7n, itemVariationData: { sku: 'OLD-SKU', priceMoney: { amount: 500, currency: 'USD' } } } } };
        }
        return { result: { object: null } };
      },
      upsertCatalogObject: async (body, merchantId) => {
        // Return success (no errors)
        return { result: {} };
      },
    });

    const app = await createApp({ firestoreMock: firestore });

    const res = await request(app).post('/api/items/update-fields').send({
      merchantId: 'MER-1',
      itemId: 'ITEM123',
      variationId: 'VAR1',
      updates: { item_name: 'New Name', sku: 'NEW-SKU', gtin: '0123456789012', price: 12.99 },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.merchantId).toBe('MER-1');
    expect(res.body.itemId).toBe('ITEM123');
    expect(res.body.variationId).toBe('VAR1');

    // applied/normalized fields
    expect(res.body.updated.item_name).toBe('New Name');
    expect(res.body.updated.sku).toBe('NEW-SKU');
    expect(res.body.updated.gtin).toBe('0123456789012');
    // price returned in dollars
    expect(res.body.updated.price).toBeCloseTo(12.99);

    // square flags
    expect(res.body.square.itemUpdated).toBe(true);
    expect(res.body.square.variationUpdated).toBe(true);

    // Firestore update counts: merchant docs: both docs? The route queries by item_id==ITEM123 (matches 1) and variation_id==VAR1 (matches 2 docs including one overlapping). Unique seen size should be 2.
    expect(res.body.firestore.updatedMerchantInventoryDocs).toBe(2);
    // global matched one
    expect(res.body.firestore.updatedGlobalInventoryDocs).toBe(1);
  });
});
