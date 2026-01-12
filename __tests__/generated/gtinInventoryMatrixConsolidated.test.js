const express = require('express');
const request = require('supertest');
const path = require('path');

// Ensure a clean module registry for deterministic mocks
beforeEach(() => {
  jest.resetModules();
});

// A small fake Firestore implementation sufficient for these tests
function makeFakeFirestore({ collections = {} } = {}) {
  function makeDocSnapshot(doc) {
    return {
      id: doc.id,
      exists: !!doc.data,
      data() {
        return doc.data;
      },
    };
  }

  class Query {
    constructor(baseDocs = []) {
      this.baseDocs = baseDocs.map(d => ({ id: d.id, data: d.data }));
      this._wheres = [];
      this._orders = [];
      this._startAt = undefined;
      this._endAt = undefined;
      this._after = undefined; // { type: 'doc' | 'kv' | 'spread', id, k?, s? }
      this._limit = undefined;
    }

    where(field, op, val) {
      this._wheres.push({ field, op, val });
      return this;
    }

    orderBy(key) {
      this._orders.push(key);
      return this;
    }

    startAt(v) {
      this._startAt = v;
      return this;
    }

    endAt(v) {
      this._endAt = v;
      return this;
    }

    limit(n) {
      this._limit = n;
      return this;
    }

    startAfter(a, b) {
      // a can be a snapshot-like object or a key value
      if (typeof a === 'object' && a !== null && a.id) {
        // doc snapshot
        this._after = { type: 'doc', id: a.id };
      } else if (typeof b === 'string') {
        // startAfter(key, id)
        this._after = { type: 'kv', k: String(a), id: b };
      } else {
        // startAfter(spread, id) for token mode
        this._after = { type: 'spread', s: Number(a), id: b };
      }
      return this;
    }

    async get() {
      let docs = this.baseDocs.slice();

      // Apply where filters
      for (const w of this._wheres) {
        if (w.op === 'array-contains') {
          docs = docs.filter(d => {
            const arr = (d.data && d.data[w.field]) || [];
            return Array.isArray(arr) && arr.includes(w.val);
          });
        } else if (w.op === '==') {
          docs = docs.filter(d => {
            const v = (d.data && d.data[w.field]);
            return v === w.val;
          });
        }
      }

      // Apply startAt/endAt for prefix or exact on ordered key
      if (this._startAt !== undefined || this._endAt !== undefined) {
        const sa = this._startAt;
        const ea = this._endAt;
        // Determine which key is being ordered on; if none, default to id
        const key = this._orders[0] || '__name__';
        docs = docs.filter(d => {
          const val = key === '__name__' ? d.id : String((d.data && d.data[key]) || '');
          if (sa !== undefined) {
            if (val < String(sa)) return false;
          }
          if (ea !== undefined) {
            // If endAt contains trailing "\uf8ff" treat as prefix upper bound
            if (String(ea).endsWith('\uf8ff')) {
              const prefix = String(ea).slice(0, -1);
              return val.startsWith(String(sa));
            }
            if (val > String(ea)) return false;
          }
          return true;
        });
      }

      // Sorting according to orderBy fields
      if (this._orders.length > 0) {
        docs.sort((A, B) => {
          for (const key of this._orders) {
            let av, bv;
            if (key === '__name__') {
              av = A.id;
              bv = B.id;
            } else {
              av = (A.data && A.data[key]) ?? '';
              bv = (B.data && B.data[key]) ?? '';
            }
            // Normalize types
            av = av === undefined || av === null ? '' : av;
            bv = bv === undefined || bv === null ? '' : bv;

            // Numeric compare if both numbers
            const an = Number(av);
            const bn = Number(bv);
            if (!Number.isNaN(an) && !Number.isNaN(bn)) {
              if (an < bn) return -1;
              if (an > bn) return 1;
            } else {
              const as = String(av);
              const bs = String(bv);
              const cmp = as.localeCompare(bs);
              if (cmp !== 0) return cmp;
            }
          }
          return 0;
        });
      } else {
        // default id order
        docs.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      }

      // Apply startAfter cursor
      if (this._after) {
        if (this._after.type === 'doc') {
          const idx = docs.findIndex(d => d.id === this._after.id);
          if (idx >= 0) docs = docs.slice(idx + 1);
        } else if (this._after.type === 'kv') {
          const keyField = this._orders[0] === '__name__' ? '__name__' : this._orders[0];
          const idx = docs.findIndex(d => {
            const kv = keyField === '__name__' ? d.id : String((d.data && d.data[keyField]) || '');
            return kv === String(this._after.k) && d.id === this._after.id;
          });
          if (idx >= 0) docs = docs.slice(idx + 1);
        } else if (this._after.type === 'spread') {
          const idx = docs.findIndex(d => {
            const spread = Number((d.data && d.data.price_spread) || 0);
            return spread === Number(this._after.s) && d.id === this._after.id;
          });
          if (idx >= 0) docs = docs.slice(idx + 1);
        }
      }

      const limited = this._limit ? docs.slice(0, this._limit) : docs;

      return {
        size: limited.length,
        docs: limited.map(d => makeDocSnapshot({ id: d.id, data: d.data })),
      };
    }
  }

  return {
    collection(name) {
      const base = collections[name] || [];
      if (name === 'location_index') {
        return {
          async get() {
            const docs = base.map(d => ({ id: d.id, data: () => d.data }));
            return { docs };
          },
        };
      }

      return new Query(base);
    },
    // For colRef.doc(id).get() support
    doc(name) {
      // Not used in tests at top-level
      return {
        get: async () => ({ exists: false }),
      };
    },
  };
}

// Mock canonicalGtin used by the route. Use absolute path to be safe.
const canonicalGtinPath = require.resolve(path.join(__dirname, '..', '..', 'lib', 'gtin'));
try {
  jest.mock(canonicalGtinPath, () => ({
    canonicalGtin: (s) => String(s),
  }));
} catch (e) {
  // If lib/gtin doesn't exist in environment, still proceed by mocking the module id used
}

const buildRouter = require('../../routes/gtinInventoryMatrixConsolidated');

function makeAppWithFirestore(firestore) {
  const app = express();
  // simple requireLogin stub
  const requireLogin = (req, res, next) => next();
  const router = buildRouter({ requireLogin, firestore });
  app.use(router);
  return app;
}

test('default list returns rows, locations and sets no-cache headers', async () => {
  const firestore = makeFakeFirestore({
    collections: {
      location_index: [
        { id: 'loc2', data: { locKey: 'L2', merchant_name: 'B' } },
        { id: 'loc1', data: { locKey: 'L1', location_name: 'Store A', merchant_id: 'M1', merchant_name: 'Shop' } },
      ],
      gtin_inventory_matrix: [
        { id: '100', data: { name_key: 'apple', name: 'Apple', sku_key: 's1', sku: 'S1', search_tokens: ['200ml'], has_mismatch: false, pricesByLocation: { L1: { price: 10 } } } },
        { id: '200', data: { name_key: 'banana', name: 'Banana', pricesByLocation: { L2: { price: 5 } } } },
      ],
    },
  });

  const app = makeAppWithFirestore(firestore);
  const res = await request(app).get('/api/gtin-inventory-matrix');

  expect(res.status).toBe(200);
  // Headers
  expect(res.headers['cache-control']).toBeDefined();
  expect(res.headers['cache-control']).toMatch(/no-store/);
  // Locations are returned in stable sorted order by label: 'B' then 'Shop'
  expect(res.body.locations).toEqual(['L2', 'L1']);
  expect(res.body.locationsMeta).toHaveProperty('L1');
  // Rows should reflect docs sorted by id
  expect(Array.isArray(res.body.rows)).toBe(true);
  expect(res.body.rows.map(r => r.gtin)).toEqual(['100', '200']);
});

test('missingOnly validation: missingTarget required and must be valid', async () => {
  const firestore = makeFakeFirestore({
    collections: {
      location_index: [
        { id: 'loc1', data: { locKey: 'L1', location_name: 'Store A' } },
      ],
      gtin_inventory_matrix: [],
    },
  });

  const app = makeAppWithFirestore(firestore);

  // missingOnly without missingTarget -> 400
  let res = await request(app).get('/api/gtin-inventory-matrix').query({ missingOnly: '1' });
  expect(res.status).toBe(400);
  expect(res.body).toHaveProperty('error');
  expect(String(res.body.error)).toMatch(/missingTarget is required/);

  // missingTarget not in locations -> 400
  res = await request(app)
    .get('/api/gtin-inventory-matrix')
    .query({ missingOnly: 'true', missingTarget: 'BAD' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/missingTarget must be one of locations/);
});

test('missingOnly filters rows missing in target and sets nextCursor (docId mode)', async () => {
  // Three docs: A present in L1 & L2, B present only in L2 (missing L1), C has no prices (excluded)
  const firestore = makeFakeFirestore({
    collections: {
      location_index: [
        { id: 'loc1', data: { locKey: 'L1', location_name: 'Store A' } },
        { id: 'loc2', data: { locKey: 'L2', location_name: 'Store B' } },
      ],
      gtin_inventory_matrix: [
        { id: 'A', data: { name: 'A', pricesByLocation: { L1: { price: 1 }, L2: { price: 2 } } } },
        { id: 'B', data: { name: 'B', pricesByLocation: { L2: { price: 3 } } } },
        { id: 'C', data: { name: 'C' /* no locations/prices */ } } },
      ],
    },
  });

  const app = makeAppWithFirestore(firestore);
  const res = await request(app)
    .get('/api/gtin-inventory-matrix')
    .query({ missingOnly: '1', missingTarget: 'L1', pageSize: '10' });

  expect(res.status).toBe(200);
  // Should return only B (missing in L1 but present somewhere)
  expect(Array.isArray(res.body.rows)).toBe(true);
  const returnedGtins = res.body.rows.map(r => r.gtin);
  expect(returnedGtins).toEqual(['B']);
  // nextCursor should be set to the last scanned doc id (docId mode)
  expect(res.body.nextCursor).toBeDefined();
  // In our fake, lastScannedDoc for the single scan is the last doc in ordered list -> 'C'
  // But nextCursor is based on lastScannedDoc; ensure it's a string id
  expect(typeof res.body.nextCursor).toBe('string');
});

test('numeric GTIN exact search returns only matching GTIN', async () => {
  const firestore = makeFakeFirestore({
    collections: {
      location_index: [
        { id: 'loc1', data: { locKey: 'L1', location_name: 'Store' } },
      ],
      gtin_inventory_matrix: [
        { id: '000000100', data: { name: 'Exact', pricesByLocation: { L1: { price: 9 } } } },
        { id: '000000101', data: { name: 'Other', pricesByLocation: { L1: { price: 5 } } } },
      ],
    },
  });

  const app = makeAppWithFirestore(firestore);
  const res = await request(app)
    .get('/api/gtin-inventory-matrix')
    .query({ q: '000000100' });

  expect(res.status).toBe(200);
  expect(res.body.rows.map(r => r.gtin)).toEqual(['000000100']);
});
