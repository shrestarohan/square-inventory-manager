const request = require('supertest');
const express = require('express');
const buildApiUpdatesRouter = require('../../routes/apiUpdates');

// Minimal in-memory Firestore mock factory used by tests
function makeMockFirestore(initial = {}) {
  const collections = new Map();

  function ensureCollection(path) {
    if (!collections.has(path)) collections.set(path, new Map());
    return collections.get(path);
  }

  // seed initial data: initial is { collectionName: { id: data } }
  for (const [col, docs] of Object.entries(initial)) {
    const m = ensureCollection(col);
    for (const [id, data] of Object.entries(docs)) m.set(id, JSON.parse(JSON.stringify(data)));
  }

  function collection(path) {
    const ctx = { path, filters: [] };

    ctx.doc = function (id) {
      const col = ensureCollection(path);
      const data = col.get(String(id));
      return {
        id: String(id),
        get: async () => {
          if (data === undefined) return { exists: false };
          return { exists: true, data: () => JSON.parse(JSON.stringify(data)) };
        },
        // allow nested collections
        collection: (sub) => collection(`${path}/${id}/${sub}`),
        // used as a ref in batch.set by our code; include a path marker
        _refPath: `${path}/${id}`,
      };
    };

    ctx.where = function (field, op, val) {
      ctx.filters.push({ field, op, val });
      return ctx;
    };

    ctx.get = async function () {
      const col = ensureCollection(path);
      const docs = [];
      for (const [id, data] of col.entries()) {
        let ok = true;
        for (const f of ctx.filters) {
          if (f.op === '==') {
            if (data[f.field] !== f.val) {
              ok = false;
              break;
            }
          } else {
            ok = false;
            break;
          }
        }
        if (ok) {
          docs.push({ id, data: () => JSON.parse(JSON.stringify(data)), ref: { _refPath: `${path}/${id}`, id } });
        }
      }
      const snapshot = {
        empty: docs.length === 0,
        size: docs.length,
        forEach: (fn) => docs.forEach(fn),
        docs,
      };
      return snapshot;
    };

    return ctx;
  }

  const batchOps = [];
  const batch = {
    set: (ref, data, opts) => {
      batchOps.push({ ref: ref._refPath || ref, data: JSON.parse(JSON.stringify(data)), opts });
    },
    commit: async () => {
      // Apply sets to collections map: parse ref path and write
      for (const op of batchOps) {
        const pathStr = typeof op.ref === 'string' ? op.ref : op.ref._refPath || String(op.ref);
        // path form: maybe like 'collection/doc' or nested 'collection/doc/subcol/doc'
        const parts = pathStr.split('/');
        if (parts.length >= 2) {
          // last two parts are collection/doc OR deeper; we consider the collection path everything before last id
          const id = parts[parts.length - 1];
          const colPath = parts.slice(0, parts.length - 1).join('/');
          const col = ensureCollection(colPath);
          // merge behavior
          const existing = col.get(id) || {};
          col.set(id, Object.assign({}, existing, op.data));
        }
      }
      batchOps.length = 0;
      return;
    },
  };

  return {
    collection,
    batch: () => batch,
    // helper for tests to inspect state
    __internal: { collections, batchOps },
  };
}

function makeSquareClient({ retrieveResponse = null, retrieveReject = null, upsertResolve = {} } = {}) {
  const retrieveCatalogObject = jest.fn(async () => {
    if (retrieveReject) throw retrieveReject;
    return retrieveResponse;
  });
  const upsertCatalogObject = jest.fn(async () => upsertResolve);
  return () => ({ catalogApi: { retrieveCatalogObject, upsertCatalogObject } });
}

function makeRequireLogin() {
  return (req, res, next) => next();
}

describe('routes/apiUpdates', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  test('POST /api/update-price - missing fields yields 400', async () => {
    const firestore = makeMockFirestore({});
    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: makeSquareClient() });
    app.use(router);

    const res = await request(app).post('/api/update-price').send({ merchantId: 'm1' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/update-price - merchant not found yields 404', async () => {
    const firestore = makeMockFirestore({});
    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: makeSquareClient() });
    app.use(router);

    const res = await request(app).post('/api/update-price').send({ merchantId: 'm1', variationId: 'v1', price: 5 });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Merchant not found');
  });

  test('POST /api/update-price - variation not ITEM_VARIATION yields 400', async () => {
    const firestore = makeMockFirestore({ merchants: { m1: { access_token: 't1', env: 'sandbox' } } });

    const sq = makeSquareClient({ retrieveResponse: { result: { object: { type: 'ITEM', itemVariationData: {} } } } });

    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: sq });
    app.use(router);

    const res = await request(app).post('/api/update-price').send({ merchantId: 'm1', variationId: 'v1', price: 4.5 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'Catalog object is not an ITEM_VARIATION');
  });

  test('POST /api/update-price - success updates inventory and matrix and commits batch', async () => {
    const initial = {
      merchants: { m1: { access_token: 'tok', env: 'sandbox' } },
      inventory: {
        inv1: { merchant_id: 'm1', variation_id: 'v1', item_id: 'it1', gtin: 'g1' },
      },
      'gtin_inventory_matrix': {
        g1: { pricesByLocation: { loc1: { merchant_id: 'm1', variation_id: 'v1', price: 100, currency: 'USD' } } },
      },
    };

    const firestore = makeMockFirestore(initial);

    const retrieveRes = {
      result: {
        object: {
          type: 'ITEM_VARIATION',
          itemVariationData: { priceMoney: { amount: 100, currency: 'USD' } },
        },
      },
    };

    const sq = makeSquareClient({ retrieveResponse: retrieveRes, upsertResolve: {} });

    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: sq });
    app.use(router);

    const res = await request(app)
      .post('/api/update-price')
      .send({ merchantId: 'm1', variationId: 'v1', price: 2.75, currency: 'USD' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // verify Square calls
    const clientInstance = sq();
    expect(clientInstance.catalogApi.retrieveCatalogObject).toHaveBeenCalledWith('v1', true);
    expect(clientInstance.catalogApi.upsertCatalogObject).toHaveBeenCalled();

    // After batch.commit, inventory doc should be updated in the mock store
    const invCol = firestore.__internal.collections.get('inventory');
    const inv1 = invCol.get('inv1');
    expect(inv1.price).toBe(2.75);
    expect(inv1.currency).toBe('USD');

    // Merchant mirror should exist at merchants/m1/inventory/inv1
    const merchantInvCol = firestore.__internal.collections.get('merchants/m1/inventory');
    expect(merchantInvCol).toBeDefined();
    const merchantInv = merchantInvCol.get('inv1');
    expect(merchantInv.price).toBe(2.75);
    expect(merchantInv.currency).toBe('USD');

    // matrix doc should be updated with new price
    const matrixCol = firestore.__internal.collections.get('gtin_inventory_matrix');
    const matrixDoc = matrixCol.get('g1');
    expect(matrixDoc.pricesByLocation.loc1.price).toBe(2.75);
    expect(matrixDoc.pricesByLocation.loc1.currency).toBe('USD');
  });

  test('POST /api/update-item-name - missing fields yields 400', async () => {
    const firestore = makeMockFirestore({});
    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: makeSquareClient() });
    app.use(router);

    const res = await request(app).post('/api/update-item-name').send({ gtin: 'g1' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('POST /api/update-item-name - empty trimmed name yields 400', async () => {
    const firestore = makeMockFirestore({});
    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: makeSquareClient() });
    app.use(router);

    const res = await request(app).post('/api/update-item-name').send({ gtin: 'g1', itemName: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'itemName cannot be empty');
  });

  test('POST /api/update-item-name - no inventory entries updates matrix and returns 0 counts', async () => {
    const initial = {
      'gtin_inventory_matrix': { g2: { item_name: 'old', item_name_lc: 'old', updated_at: 'old' } },
    };
    const firestore = makeMockFirestore(initial);
    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: makeSquareClient() });
    app.use(router);

    const res = await request(app).post('/api/update-item-name').send({ gtin: 'g2', itemName: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, updatedItems: 0, updatedDocs: 0 });

    const matrixCol = firestore.__internal.collections.get('gtin_inventory_matrix');
    const matrixDoc = matrixCol.get('g2');
    expect(matrixDoc.item_name).toBe('New Name');
    expect(matrixDoc.item_name_lc).toBe('new name');
  });

  test('POST /api/update-item-name - updates items, calls Square for merchants and commits batch', async () => {
    const initial = {
      merchants: {
        m1: { access_token: 't1', env: 'sandbox' },
        m2: { access_token: 't2', env: 'sandbox' },
      },
      inventory: {
        invA: { merchant_id: 'm1', item_id: 'itemA', gtin: 'g3' },
        invB: { merchant_id: 'm2', item_id: 'itemB', gtin: 'g3' },
        invC: { merchant_id: 'm2', item_id: 'itemB', gtin: 'g3' }, // duplicate combo
      },
    };

    const firestore = makeMockFirestore(initial);

    // Square client should respond with ITEM objects for both itemA and itemB
    const retrieveResponses = {
      itemA: { result: { object: { type: 'ITEM', itemData: { name: 'old' } } } },
      itemB: { result: { object: { type: 'ITEM', itemData: { name: 'old' } } } },
    };

    const upsertCalls = [];
    const makeClient = () => {
      const catalogApi = {
        retrieveCatalogObject: jest.fn(async (id) => retrieveResponses[id] || { result: { object: null } }),
        upsertCatalogObject: jest.fn(async (payload) => {
          upsertCalls.push(payload);
          return {};
        }),
      };
      return () => ({ catalogApi });
    };

    const router = buildApiUpdatesRouter({ requireLogin: makeRequireLogin(), firestore, createSquareClient: makeClient() });
    app.use(router);

    const res = await request(app).post('/api/update-item-name').send({ gtin: 'g3', itemName: 'Brand New Name' });
    expect(res.status).toBe(200);
    // combos: itemA (m1|itemA) and itemB (m2|itemB) => 2 unique
    expect(res.body.success).toBe(true);
    expect(res.body.updatedItems).toBe(2);
    expect(res.body.updatedDocs).toBe(3);

    // verify Square upserts were called twice (for itemA and itemB)
    expect(upsertCalls.length).toBe(2);

    // inventory docs and merchant mirrors updated
    const invCol = firestore.__internal.collections.get('inventory');
    for (const id of ['invA', 'invB', 'invC']) {
      const doc = invCol.get(id);
      expect(doc.item_name).toBe('Brand New Name');
      expect(doc.item_name_lc).toBe('brand new name');
    }

    const m1Inv = firestore.__internal.collections.get('merchants/m1/inventory');
    expect(m1Inv.get('invA').item_name).toBe('Brand New Name');
    const m2Inv = firestore.__internal.collections.get('merchants/m2/inventory');
    expect(m2Inv.get('invB').item_name).toBe('Brand New Name');
    expect(m2Inv.get('invC').item_name).toBe('Brand New Name');

    // matrix doc exists and updated
    const matrixCol = firestore.__internal.collections.get('gtin_inventory_matrix');
    const matrixDoc = matrixCol.get('g3');
    expect(matrixDoc.item_name).toBe('Brand New Name');
    expect(matrixDoc.item_name_lc).toBe('brand new name');
  });
});
