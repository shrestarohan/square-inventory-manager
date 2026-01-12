const request = require('supertest');
const express = require('express');
const path = require('path');

// Minimal in-memory Mock Firestore to support the operations used by the router
class DocumentRef {
  constructor(firestore, collectionName, id) {
    this._fs = firestore;
    this.collection = collectionName;
    this.id = id;
  }
  async set(data, opts = {}) {
    return this._fs._setDoc(this.collection, this.id, data, opts);
  }
}

class MockFirestore {
  constructor(initial = {}) {
    this._data = {}; // collectionName -> Map(id -> data)
    for (const [col, docs] of Object.entries(initial)) {
      this._data[col] = new Map();
      for (const d of docs) {
        this._data[col].set(d.id, JSON.parse(JSON.stringify(d.data || {})));
      }
    }
  }

  collection(name) {
    const fs = this;
    return {
      doc(id) {
        return new DocumentRef(fs, name, id);
      },
      async get() {
        const map = fs._data[name] || new Map();
        const docs = [];
        for (const [id, data] of map.entries()) {
          docs.push({ id, ref: new DocumentRef(fs, name, id), data: () => JSON.parse(JSON.stringify(data)) });
        }
        return { empty: docs.length === 0, docs };
      },
      where(field, op, value) {
        return new Query(fs, name, [[field, op, value]]);
      },
      async add(data) {
        const id = Math.random().toString(36).slice(2, 10);
        if (!fs._data[name]) fs._data[name] = new Map();
        fs._data[name].set(id, JSON.parse(JSON.stringify(data)));
        return { id };
      },
    };
  }

  _setDoc(collection, id, data, opts = {}) {
    if (!this._data[collection]) this._data[collection] = new Map();
    const existing = this._data[collection].get(id) || {};
    if (opts && opts.merge) {
      const merged = Object.assign({}, existing, JSON.parse(JSON.stringify(data)));
      this._data[collection].set(id, merged);
    } else {
      this._data[collection].set(id, JSON.parse(JSON.stringify(data)));
    }
    return Promise.resolve();
  }

  batch() {
    const ops = [];
    const fs = this;
    return {
      set(ref, data, opts = {}) {
        ops.push({ ref, data, opts });
      },
      async commit() {
        for (const o of ops) {
          // ref is DocumentRef like object
          await fs._setDoc(o.ref.collection, o.ref.id, o.data, o.opts);
        }
      },
    };
  }

  // helper to seed collections
  _seedCollection(name, docs = []) {
    if (!this._data[name]) this._data[name] = new Map();
    for (const d of docs) {
      this._data[name].set(d.id, JSON.parse(JSON.stringify(d.data || {})));
    }
  }

  // helper to read doc
  _getDoc(collection, id) {
    const m = this._data[collection] || new Map();
    const val = m.get(id);
    return val ? JSON.parse(JSON.stringify(val)) : null;
  }

  // helper to query (used by tests for assertions)
  _getAllDocs(collection) {
    const m = this._data[collection] || new Map();
    const out = [];
    for (const [id, data] of m.entries()) out.push({ id, data: JSON.parse(JSON.stringify(data)) });
    return out;
  }
}

class Query {
  constructor(firestore, collection, filters = []) {
    this._fs = firestore;
    this._collection = collection;
    this._filters = filters.slice();
    this._limit = null;
  }
  where(field, op, value) {
    this._filters.push([field, op, value]);
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  async get() {
    const map = this._fs._data[this._collection] || new Map();
    const docs = [];
    for (const [id, data] of map.entries()) {
      let ok = true;
      for (const [field, op, value] of this._filters) {
        const fieldVal = data ? data[field] : undefined;
        if (op === '==' && fieldVal !== value) { ok = false; break; }
        // only == is used in the router
      }
      if (ok) docs.push({ id, ref: new DocumentRef(this._fs, this._collection, id), data: () => JSON.parse(JSON.stringify(data)) });
    }
    if (this._limit != null) docs.splice(this._limit);
    return { empty: docs.length === 0, docs };
  }
}

// Ensure we reset modules and provide a controllable mock for lib/square.
beforeEach(() => {
  jest.resetModules();
  // global map for square clients per merchant id
  global.__SQUARE_CLIENTS__ = {};
});

afterEach(() => {
  delete global.__SQUARE_CLIENTS__;
});

function setupAppWithMocks(firestore) {
  // mock the ../lib/square module used by routes/categoryActions.js
  const squareModulePath = path.resolve(__dirname, '../../lib/square.js');
  jest.mock(squareModulePath, () => {
    return {
      makeCreateSquareClientForMerchant: jest.fn(() => {
        // returns a function that when called, returns a squareClient from global map
        return async ({ merchantId }) => {
          // allow tests to inject clients into global.__SQUARE_CLIENTS__
          return global.__SQUARE_CLIENTS__[merchantId];
        };
      }),
    };
  });

  // now require the router after mocking
  const buildCategoryActionsRouter = require('../../routes/categoryActions');

  const app = express();
  app.use(express.json());
  // simple requireLogin that sets a user
  const requireLogin = (req, res, next) => {
    req.user = { email: 'test@example.com' };
    next();
  };

  const router = buildCategoryActionsRouter({ firestore, requireLogin });
  app.use(router);
  return app;
}

describe('routes/categoryActions', () => {
  test('POST /api/categories/copy - missing fromMerchantId returns 400', async () => {
    const fs = new MockFirestore();
    const app = setupAppWithMocks(fs);
    const res = await request(app).post('/api/categories/copy').send({ toMerchantId: 'm2' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Missing fromMerchantId/);
  });

  test('POST /api/categories/copy - source not found returns 404', async () => {
    const fs = new MockFirestore({ square_categories: [] });
    const app = setupAppWithMocks(fs);
    const res = await request(app).post('/api/categories/copy').send({ fromMerchantId: 'm1', toMerchantId: 'm2', categoryId: 'cid' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Source category not found/);
  });

  test('POST /api/categories/copy - destination already exists returns alreadyExists true', async () => {
    const srcDoc = { id: 'm1__s1', data: { merchant_id: 'm1', category_id: 's1', category_name: 'Food' } };
    const destDoc = { id: 'm2__d1', data: { merchant_id: 'm2', category_id: 'd1', category_name: 'Food', is_deleted: false } };
    const fs = new MockFirestore({ square_categories: [srcDoc, destDoc] });
    const app = setupAppWithMocks(fs);

    const res = await request(app).post('/api/categories/copy').send({ fromMerchantId: 'm1', toMerchantId: 'm2', categoryName: 'Food' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.alreadyExists).toBe(true);
    expect(res.body.toMerchantId).toBe('m2');
    expect(res.body.categoryName).toBe('Food');
    expect(res.body.categoryId).toBe('d1');
  });

  test('POST /api/categories/copy - creates in Square and upserts Firestore', async () => {
    const srcDoc = { id: 'm1__s1', data: { merchant_id: 'm1', category_id: 's1', category_name: 'Beverages' } };
    const fs = new MockFirestore({ square_categories: [srcDoc] });

    // Mock square client for merchant m2
    global.__SQUARE_CLIENTS__['m2'] = {
      catalogApi: {
        upsertCatalogObject: jest.fn().mockResolvedValue({ result: { catalogObject: { id: 'newCat', version: 7 } } }),
      },
    };

    const app = setupAppWithMocks(fs);

    const res = await request(app).post('/api/categories/copy').send({ fromMerchantId: 'm1', toMerchantId: 'm2', categoryId: 's1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.alreadyExists).toBe(false);
    expect(res.body.newCategoryId).toBe('newCat');

    // verify Firestore doc created
    const created = fs._getDoc('square_categories', 'm2__newCat');
    expect(created).not.toBeNull();
    expect(created.merchant_id).toBe('m2');
    expect(created.category_id).toBe('newCat');
    expect(created.category_name).toBe('Beverages');
    expect(created.is_deleted).toBe(false);
    expect(created.copied_from).toBeTruthy();
    expect(created.copied_from.from_merchant_id).toBe('m1');
    expect(created.copied_from.actor).toBe('test@example.com');
  });

  test('POST /api/categories/delete-all - missing categoryName returns 400', async () => {
    const fs = new MockFirestore();
    const app = setupAppWithMocks(fs);
    const res = await request(app).post('/api/categories/delete-all').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/categoryName required/);
  });

  test('POST /api/categories/delete-all - no matching docs returns 404', async () => {
    const fs = new MockFirestore({ square_categories: [] });
    const app = setupAppWithMocks(fs);
    const res = await request(app).post('/api/categories/delete-all').send({ categoryName: 'NonExistent' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/No Firestore categories found/);
  });

  test('POST /api/categories/delete-all - deletes across merchants, marks FS, and writes audit log', async () => {
    // Seed two merchants with category name "Desserts"
    const docs = [
      { id: 'm1__c1', data: { merchant_id: 'm1', category_id: 'c1', category_name: 'Desserts', is_deleted: false } },
      { id: 'm2__c2', data: { merchant_id: 'm2', category_id: 'c2', category_name: 'Desserts', is_deleted: false } },
      { id: 'm2__c3', data: { merchant_id: 'm2', category_id: 'c3', category_name: 'Desserts', is_deleted: false } },
    ];
    const fs = new MockFirestore({ square_categories: docs, audit_logs: [] });

    // Mock square clients for m1 and m2 with deleteCatalogObject
    global.__SQUARE_CLIENTS__['m1'] = {
      catalogApi: {
        deleteCatalogObject: jest.fn().mockResolvedValue({ result: { ok: true } }),
      },
    };
    global.__SQUARE_CLIENTS__['m2'] = {
      catalogApi: {
        deleteCatalogObject: jest.fn().mockResolvedValue({ result: { ok: true } }),
      },
    };

    const app = setupAppWithMocks(fs);

    const res = await request(app).post('/api/categories/delete-all').send({ categoryName: 'Desserts' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.categoryName).toBe('Desserts');
    expect(Array.isArray(res.body.results)).toBe(true);

    // There should be two merchant results: m1 (count 1) and m2 (count 2)
    const rByMid = {};
    for (const r of res.body.results) rByMid[r.merchantId] = r;
    expect(rByMid['m1']).toBeTruthy();
    expect(rByMid['m1'].count).toBe(1);
    expect(rByMid['m1'].squareOk).toBe(true);
    expect(rByMid['m2']).toBeTruthy();
    expect(rByMid['m2'].count).toBe(2);
    expect(rByMid['m2'].squareOk).toBe(true);

    // Verify Firestore docs updated to is_deleted true and deleted_by set
    const all = fs._getAllDocs('square_categories');
    const byId = {};
    for (const d of all) byId[d.id] = d.data;
    expect(byId['m1__c1'].is_deleted).toBe(true);
    expect(byId['m1__c1'].deleted_by).toBe('test@example.com');
    expect(byId['m2__c2'].is_deleted).toBe(true);
    expect(byId['m2__c3'].is_deleted).toBe(true);

    // Verify audit log was written
    const audits = fs._getAllDocs('audit_logs');
    expect(audits.length).toBe(1);
    const audit = audits[0].data;
    expect(audit.type).toBe('DELETE_CATEGORY_ALL_MERCHANTS');
    expect(audit.category_name).toBe('Desserts');
    expect(audit.actor).toBe('test@example.com');
    expect(Array.isArray(audit.results)).toBe(true);
    expect(audit.results.length).toBe(2);
  });
});
