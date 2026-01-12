const request = require('supertest');
const express = require('express');

// Mock the negativeInventoryService BEFORE requiring the routes module
jest.mock('../../services/negativeInventoryService', () => ({
  listNegatives: jest.fn(),
  writeFixAudit: jest.fn(),
}));

const { listNegatives, writeFixAudit } = require('../../services/negativeInventoryService');

const buildInventoryIntegrityRoutes = require('../../routes/inventoryIntegrityRoutes');

// Helper to create a fake Firestore with minimal behavior required by the routes
function makeFakeFirestore(docs = {}) {
  // docs is a map from path string e.g. 'inventory/doc1' or 'merchants/m1/inventory/doc1' to plain object

  function pathJoin(parts) {
    return parts.filter(Boolean).join('/');
  }

  function makeRef(pathParts) {
    const path = pathJoin(pathParts);
    return {
      id: path.split('/').pop(),
      _path: path,
      collection(name) {
        return {
          doc: (id) => makeRef([...pathParts, name, id]),
        };
      },
      get: async () => {
        const data = docs[path];
        return {
          exists: data !== undefined,
          id: path.split('/').pop(),
          data: () => (data === undefined ? undefined : data),
        };
      },
      // allow equality or inspect in tx.get
    };
  }

  const root = {
    collection(name) {
      return {
        doc: (id) => makeRef([name, id]),
      };
    },
    // runTransaction expects an async function(tx => ...)
    runTransaction: async (txFn) => {
      // tx should expose get and set
      const tx = {
        get: async (ref) => {
          // ref may be an object from above or something with _path
          const path = ref && ref._path ? ref._path : undefined;
          const data = docs[path];
          return {
            exists: data !== undefined,
            id: path ? path.split('/').pop() : undefined,
            data: () => (data === undefined ? undefined : data),
          };
        },
        set: (ref, patch) => {
          const path = ref && ref._path ? ref._path : undefined;
          if (path) {
            // merge semantics: shallow merge
            const existing = docs[path] || {};
            docs[path] = Object.assign({}, existing, patch);
          }
        },
      };
      return txFn(tx);
    },
  };

  return root;
}

describe('inventoryIntegrityRoutes', () => {
  let app;
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
  });

  test('GET /inventory/negatives - returns rows from listNegatives', async () => {
    const fakeRows = [ { id: 'r1', qty: -2 }, { id: 'r2', qty: -5 }];
    listNegatives.mockResolvedValueOnce(fakeRows);

    const firestore = makeFakeFirestore();

    const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
    app.use(router);

    const res = await request(app).get('/inventory/negatives').query({ limit: 10, q: 'term' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.rows).toEqual(fakeRows);

    expect(listNegatives).toHaveBeenCalledWith(expect.objectContaining({ firestore, limit: 10, q: 'term' }));
  });

  test('GET /inventory/negatives - handles service error', async () => {
    listNegatives.mockRejectedValueOnce(new Error('boom'));
    const firestore = makeFakeFirestore();
    const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
    app.use(router);

    const res = await request(app).get('/inventory/negatives').expect(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('boom');
  });

  test('GET /inventory/row - missing docId returns 400', async () => {
    const firestore = makeFakeFirestore();
    const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
    app.use(router);

    const res = await request(app).get('/inventory/row').expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/docId required/);
  });

  test('GET /inventory/row - not found returns 404', async () => {
    const firestore = makeFakeFirestore({});
    const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
    app.use(router);

    const res = await request(app).get('/inventory/row').query({ docId: 'nope' }).expect(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Not found');
  });

  test('GET /inventory/row - returns transformed row', async () => {
    const docs = {
      'inventory/doc1': {
        merchant_id: 'm1',
        location_id: 'l1',
        location_name: 'Loc 1',
        gtin: '000',
        item_name: 'Item Name',
        sku: 'S1',
        qty: 3,
      },
    };
    const firestore = makeFakeFirestore(docs);
    const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
    app.use(router);

    const res = await request(app).get('/inventory/row').query({ docId: 'doc1' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.row).toEqual({
      id: 'doc1',
      merchant_id: 'm1',
      location_id: 'l1',
      location_name: 'Loc 1',
      gtin: '000',
      name: 'Item Name',
      sku: 'S1',
      qty: 3,
    });
  });

  describe('POST /inventory/fix validations', () => {
    test('missing docId or action -> 400', async () => {
      const firestore = makeFakeFirestore();
      const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
      app.use(router);

      await request(app).post('/inventory/fix').send({}).expect(400);
      await request(app).post('/inventory/fix').send({ docId: 'd1' }).expect(400);
      await request(app).post('/inventory/fix').send({ action: 'ADJUST_TO_ZERO' }).expect(400);
    });

    test('unsupported action -> 400', async () => {
      const firestore = makeFakeFirestore();
      const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
      app.use(router);

      await request(app).post('/inventory/fix').send({ docId: 'd1', action: 'FOO' }).expect(400);
    });

    test('SET_COUNTED_QTY with invalid countedQty -> 400', async () => {
      const firestore = makeFakeFirestore();
      const router = buildInventoryIntegrityRoutes({ firestore, requireLogin: null });
      app.use(router);

      await request(app).post('/inventory/fix').send({ docId: 'd1', action: 'SET_COUNTED_QTY', countedQty: -5 }).expect(400);
      await request(app).post('/inventory/fix').send({ docId: 'd1', action: 'SET_COUNTED_QTY', countedQty: 'nan' }).expect(400);
    });
  });

  test('POST /inventory/fix - successful adjust to zero without applying to Square', async () => {
    // Setup a document that exists in inventory and also expect merchant copy
    const docs = {
      'inventory/doc1': {
        merchant_id: 'm123',
        location_id: 'locX',
        variation_id: 'varY',
        qty: -7,
      },
      // merchant specific doc may or may not exist initially; runTransaction.set will create/merge it
    };

    const firestore = makeFakeFirestore(docs);

    // Provide a simple requireLogin middleware that injects req.user
    const requireLogin = (req, res, next) => {
      req.user = { email: 'tester@example.com', id: 'tester1' };
      next();
    };

    const router = buildInventoryIntegrityRoutes({ firestore, requireLogin, createSquareClient: null });
    app.use(router);

    const res = await request(app)
      .post('/inventory/fix')
      .send({ docId: 'doc1', action: 'ADJUST_TO_ZERO', note: 'fixing', applyToSquare: false })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.result).toEqual({ changed: true, beforeQty: -7, afterQty: 0 });
    expect(res.body.squareApplied).toBe(false);
    expect(res.body.squareMeta).toBeNull();

    // Verify that the inventory documents were updated in our fake store
    expect(docs['inventory/doc1'].qty).toBe(0);
    // After runTransaction, merchant version should also be created/merged
    expect(docs['merchants/m123/inventory/doc1'].qty).toBe(0);

    // Ensure audit was written with expected payload shape (stripUndefined applied)
    expect(writeFixAudit).toHaveBeenCalledTimes(1);
    const callArg = writeFixAudit.mock.calls[0][0];
    expect(callArg).toHaveProperty('firestore');
    expect(callArg.payload).toMatchObject({
      action: 'ADJUST_TO_ZERO',
      merchant_id: 'm123',
      inventory_doc_id: 'doc1',
      before_qty: -7,
      after_qty: 0,
      note: 'fixing',
      actor: 'tester@example.com',
      square_applied: false,
      square_result: null,
      square_location_id: 'locX',
      square_variation_id: 'varY',
    });
  });
});
