// Jest tests for routes/deleteGtin.js

const express = require("express");
const request = require("supertest");

// Mock FieldValue.delete used by the route
jest.mock("@google-cloud/firestore", () => ({
  FieldValue: {
    delete: () => ({ __fieldDelete: true }),
  },
}));

// Mock canonicalGtin/normalizeDigits
jest.mock("../../lib/gtin", () => ({
  canonicalGtin: (s = "") => String(s).replace(/\D/g, ""),
  normalizeDigits: (s = "") => String(s).replace(/\D/g, ""),
}));

const { FieldValue } = require("@google-cloud/firestore");
const buildDeleteGtinRouter = require("../../routes/deleteGtin");

// Minimal in-memory Firestore mock to satisfy the route's usage
function createMockFirestore(initialDocs = []) {
  // storage: key => data, key is full path like 'inventory/doc1' or 'merchants/m1/inventory/docX'
  const storage = new Map();
  for (const d of initialDocs) {
    storage.set(d.path, JSON.parse(JSON.stringify(d.data)));
  }

  function collection(pathSeg) {
    const basePath = pathSeg; // e.g., 'inventory' or 'merchants'

    function doc(id) {
      const docPath = `${basePath}/${id}`;
      return makeDocRef(docPath);
    }

    function where(field, op, value) {
      const filters = [{ field, op, value }];
      return makeQuery(basePath, filters);
    }

    return { doc, collection: (name) => collection(`${basePath}/${name}`), where, _basePath: basePath };
  }

  function makeDocRef(path) {
    return {
      path,
      id: path.split("/").pop(),
      collection: (name) => collection(`${path}/${name}`),
      async get() {
        const data = storage.get(path);
        return {
          exists: data !== undefined,
          data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
        };
      },
      async delete() {
        storage.delete(path);
      },
      async update(updateObj) {
        // updateObj keys may be dotted paths like 'pricesByLocation.loc1'
        let existing = storage.get(path) || {};
        existing = JSON.parse(JSON.stringify(existing));
        for (const [k, v] of Object.entries(updateObj)) {
          const parts = k.split('.');
          let cur = existing;
          for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (cur[p] === undefined || cur[p] === null) cur[p] = {};
            cur = cur[p];
          }
          const last = parts[parts.length - 1];
          // If value is FieldValue.delete sentinel, delete that key
          if (v && typeof v === 'object' && v.__fieldDelete) {
            delete cur[last];
          } else {
            cur[last] = v;
          }
        }
        storage.set(path, existing);
      },
    };
  }

  function makeQuery(basePath, filters = []) {
    let limitN = Infinity;
    function where(field, op, value) {
      filters.push({ field, op, value });
      return makeQuery(basePath, filters);
    }
    function limit(n) {
      limitN = n;
      return { get };
    }
    async function get() {
      // collect docs whose path starts with `${basePath}/` and have no extra nesting beyond this collection
      const docs = [];
      for (const [path, data] of storage.entries()) {
        if (!path.startsWith(`${basePath}/`)) continue;
        // ensure this doc is directly in this collection (i.e., path segments count = basePathSegments + 1)
        const baseSegs = basePath.split('/').filter(Boolean).length;
        const totalSegs = path.split('/').filter(Boolean).length;
        if (totalSegs !== baseSegs + 1) continue;
        let match = true;
        for (const f of filters) {
          // only support '==' currently
          if (f.op === '==' ) {
            if ((data && data[f.field]) !== f.value) {
              match = false; break;
            }
          } else {
            match = false; break;
          }
        }
        if (match) {
          const docRef = makeDocRef(path);
          docs.push({ ref: docRef, data: () => JSON.parse(JSON.stringify(data)) });
        }
      }
      const limited = docs.slice(0, limitN);
      return {
        empty: limited.length === 0,
        size: limited.length,
        docs: limited,
      };
    }
    return { where, limit, get };
  }

  function batch() {
    const deletes = [];
    return {
      delete(ref) {
        deletes.push(ref.path);
      },
      async commit() {
        for (const p of deletes) storage.delete(p);
      },
    };
  }

  return {
    collection,
    batch,
    // helpers for tests
    _storage: storage,
  };
}

// A small requireLogin middleware used in tests
function allowAllLogin(req, res, next) {
  req.user = { id: 'test-user' };
  return next();
}

describe("routes/deleteGtin", () => {
  test("builder throws if createSquareClient not provided", () => {
    expect(() => buildDeleteGtinRouter({ requireLogin: allowAllLogin, firestore: createMockFirestore() })).toThrow(
      /createSquareClient must be passed into buildDeleteGtinRouter\(\)/
    );
  });

  test("returns 400 when gtin missing", async () => {
    const firestore = createMockFirestore();
    const router = buildDeleteGtinRouter({ requireLogin: allowAllLogin, firestore, createSquareClient: () => ({}) });
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const resp = await request(app).post('/api/delete-item').send({});
    expect(resp.status).toBe(400);
    expect(resp.body).toMatchObject({ success: false, error: 'gtin required' });
  });

  test("gtin not in consolidated doc deletes global inventory only", async () => {
    // initial global inventory has two docs for gtin '123'
    const initial = [
      { path: 'inventory/inv1', data: { gtin: '123', merchant_id: 'mX' } },
      { path: 'inventory/inv2', data: { gtin: '123', merchant_id: 'mY' } },
    ];
    const firestore = createMockFirestore(initial);

    const createSquareClient = jest.fn().mockResolvedValue({ catalogApi: { deleteCatalogObject: async () => ({ statusCode: 200 }) } });
    const router = buildDeleteGtinRouter({ requireLogin: allowAllLogin, firestore, createSquareClient });
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const resp = await request(app).post('/api/delete-item').send({ gtin: '123' });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(typeof resp.body.message === 'string').toBe(true);
    expect(resp.body.message).toMatch(/Not found in gtin_inventory_matrix/);

    // global inventory should be deleted
    expect(firestore._storage.has('inventory/inv1')).toBe(false);
    expect(firestore._storage.has('inventory/inv2')).toBe(false);
  });

  test("consolidated doc present: deletes merchant/global entries, calls Square, and removes consolidated doc", async () => {
    // Setup consolidated doc and inventory entries for two merchants
    const gtin = '000123';
    const initial = [
      {
        path: `gtin_inventory_matrix/${gtin}`,
        data: {
          pricesByLocation: {
            loc1: { merchant_id: 'm1', variation_id: 'v1', item_id: 'i1' },
            loc2: { merchant_id: 'm2', variation_id: 'v2' },
          },
        },
      },
      // global inventory docs
      { path: 'inventory/g1', data: { gtin: gtin, merchant_id: 'm1' } },
      { path: 'inventory/g2', data: { gtin: gtin, merchant_id: 'm2' } },
      // merchant-scoped inventory
      { path: `merchants/m1/inventory/im1`, data: { gtin: gtin } },
      // merchant matrices that should be deleted
      { path: `merchants/m1/gtin_matrix/${gtin}`, data: { some: 'x' } },
      { path: `merchants/m1/gtin_inventory_matrix/${gtin}`, data: { some: 'y' } },
      // also a merchant 2 matrix to ensure it's fine (even if not present for m2 in merchant-level docs)
      { path: `merchants/m2/gtin_matrix/${gtin}`, data: { some: 'z' } },
    ];

    const firestore = createMockFirestore(initial);

    // createSquareClient that returns a client with catalogApi.deleteCatalogObject
    const deleteCalls = [];
    const createSquareClient = jest.fn(async ({ merchantId }) => {
      return {
        catalogApi: {
          deleteCatalogObject: async (objectId) => {
            deleteCalls.push({ merchantId, objectId });
            return { statusCode: 200 };
          },
        },
      };
    });

    const router = buildDeleteGtinRouter({ requireLogin: allowAllLogin, firestore, createSquareClient });
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const resp = await request(app).post('/api/delete-item').send({ gtin: gtin });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(Array.isArray(resp.body.results)).toBe(true);

    // Should have results for m1 and m2
    const mids = resp.body.results.map(r => r.merchantId).sort();
    expect(mids).toEqual(['m1', 'm2']);

    const r1 = resp.body.results.find(r => r.merchantId === 'm1');
    expect(r1.fsDeleted.merchant).toBe(1); // one merchant inventory doc for m1
    expect(r1.fsDeleted.global).toBe(1);  // one global doc for m1
    expect(r1.square.attempted).toBe(2);  // v1 + i1
    expect(r1.square.ok).toBe(2);

    const r2 = resp.body.results.find(r => r.merchantId === 'm2');
    expect(r2.fsDeleted.merchant).toBe(0); // no merchant-level inventory for m2 in initial
    expect(r2.fsDeleted.global).toBe(1);  // one global doc for m2
    expect(r2.square.attempted).toBe(1);  // v2 only
    expect(r2.square.ok).toBe(1);

    // Consolidated doc should be deleted (full delete path when no merchantIdParam)
    expect(firestore._storage.has(`gtin_inventory_matrix/${gtin}`)).toBe(false);

    // merchant-level matrix docs for m1 should be deleted
    expect(firestore._storage.has(`merchants/m1/gtin_matrix/${gtin}`)).toBe(false);
    expect(firestore._storage.has(`merchants/m1/gtin_inventory_matrix/${gtin}`)).toBe(false);

    // ensure createSquareClient was called for both merchants
    const createdFor = createSquareClient.mock.calls.map(c => c[0].merchantId).sort();
    expect(createdFor).toEqual(['m1', 'm2']);

    // ensure deleteCatalogObject was called for all ids (v1,i1 for m1; v2 for m2)
    const expectedDeleteObjs = deleteCalls.map(d => `${d.merchantId}:${d.objectId}`).sort();
    expect(expectedDeleteObjs).toEqual(['m1:i1', 'm1:v1', 'm2:v2'].sort());
  });
});
