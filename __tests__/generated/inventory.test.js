// Jest tests for routes/inventory.js
// Run with: jest --runInBand

// Mock FieldPath from @google-cloud/firestore before requiring the route module
jest.mock('@google-cloud/firestore', () => ({
  FieldPath: {
    // Return a simple sentinel (string) for documentId(), route code just passes this through to orderBy
    documentId: () => '__name__',
  },
}));

const express = require('express');
const request = require('supertest');
const Buffer = require('buffer').Buffer;

// Now require the router factory
const buildInventoryRouter = require('../../routes/inventory');

// Helper: create a fake Firestore-like object that supports the chained query methods used in the route
function createFakeFirestore(docsByPath) {
  // docsByPath is a map of pathKey -> array of { id, data }
  // pathKey examples: 'inventory' for root, 'merchants:MERCHANT_ID:inventory' for merchant-specific

  // Helper to obtain docs array by path
  const getDocsForPath = (pathKey) => {
    return docsByPath[pathKey] || [];
  };

  // Query class
  class Query {
    constructor(baseDocs) {
      this._baseDocs = baseDocs; // array of {id, data}
      this._filters = []; // { field, op, val }
      this._orderBys = [];
      this._startAt = null;
      this._endAt = null;
      this._startAfter = null; // store values
      this._limit = Infinity;
    }

    where(field, op, val) {
      this._filters.push({ field, op, val });
      return this;
    }

    orderBy(field) {
      this._orderBys.push(field);
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

    startAfter(...vals) {
      this._startAfter = vals;
      return this;
    }

    limit(n) {
      this._limit = n;
      return this;
    }

    // Firestore Query.get -> return snapshot-like object
    async get() {
      let results = this._baseDocs.slice(); // copy

      // Apply filters
      for (const f of this._filters) {
        if (f.field === 'category_id' && f.op === '==' && f.val === null) {
          results = results.filter((d) => d.data.category_id === null || typeof d.data.category_id === 'undefined');
          continue;
        }

        if (f.field === 'gtin' && f.op === '==') {
          results = results.filter((d) => String(d.data.gtin || '') === String(f.val));
          continue;
        }

        if (f.field === 'sku' && f.op === '==') {
          results = results.filter((d) => String(d.data.sku || '') === String(f.val));
          continue;
        }

        if (f.field === 'search_tokens' && f.op === 'array-contains') {
          results = results.filter((d) => Array.isArray(d.data.search_tokens) && d.data.search_tokens.includes(f.val));
          continue;
        }

        // Generic fallback: try equality on nested data key
        results = results.filter((d) => {
          const value = d.data && d.data[f.field];
          if (f.op === '==') return value === f.val;
          return true;
        });
      }

      // Handle startAt/endAt for item_prefix: approximate with startsWith on item_name_lc
      if (this._startAt !== null && this._endAt !== null) {
        const start = String(this._startAt);
        results = results.filter((d) => typeof d.data.item_name_lc === 'string' && d.data.item_name_lc.startsWith(start));
      }

      // Handle startAfter crudely: if provided with a document snapshot-like or (v,id) pair, skip until id > provided id
      if (this._startAfter) {
        const vals = this._startAfter;
        // If first value is a string and second exists, assume (v, id)
        if (vals.length >= 2 && typeof vals[1] === 'string') {
          const afterId = String(vals[1]);
          // remove all docs up to and including afterId
          let seen = false;
          const filtered = [];
          for (const d of results) {
            if (!seen) {
              if (d.id === afterId) {
                seen = true;
                continue; // skip the matched one
              }
              continue; // skip until we see it
            }
            filtered.push(d);
          }
          // If we never saw the id, keep results as-is (mimic not applying startAfter)
          if (seen) results = filtered;
        } else if (vals.length === 1 && vals[0] && typeof vals[0] === 'object' && vals[0].id) {
          // startAfter(documentSnapshot) - skip docs up to that id
          const afterId = String(vals[0].id);
          let seen = false;
          const filtered = [];
          for (const d of results) {
            if (!seen) {
              if (d.id === afterId) {
                seen = true;
                continue;
              }
              continue;
            }
            filtered.push(d);
          }
          if (seen) results = filtered;
        }
      }

      // Apply limit
      results = results.slice(0, this._limit);

      const docs = results.map((d) => ({ id: d.id, data: () => d.data }));
      return {
        docs,
        size: docs.length,
        empty: docs.length === 0,
      };
    }
  }

  // Build collection ref for root inventory or merchant inventory
  const collection = (name) => {
    if (name === 'merchants') {
      // return an object with doc(id).collection('inventory')
      return {
        doc: (merchantId) => ({
          collection: (subName) => {
            const key = `merchants:${merchantId}:${subName}`;
            const baseDocs = getDocsForPath(key);
            return new Query(baseDocs);
          },
        }),
      };
    }

    // inventory root
    return {
      collectionName: name,
      // For chainability in route code, collection('inventory') returns an object used as colRef
      // We return a Query instance wrapper by providing a factory when orderBy/where/limit called
      // But route code calls colRef.where(...).orderBy(...).limit(...)
      // So return a simple object that delegates to new Query with baseDocs
      _makeQuery: () => new Query(getDocsForPath(name)),
      where: function (field, op, val) {
        return this._makeQuery().where(field, op, val);
      },
      orderBy: function (field) {
        return this._makeQuery().orderBy(field);
      },
      startAt: function (v) {
        return this._makeQuery().startAt(v);
      },
      endAt: function (v) {
        return this._makeQuery().endAt(v);
      },
      startAfter: function (...vals) {
        return this._makeQuery().startAfter(...vals);
      },
      limit: function (n) {
        return this._makeQuery().limit(n);
      },
      doc: function (id) {
        // doc ref get() should search this collection's base docs
        const baseDocs = getDocsForPath(name);
        return {
          get: async () => {
            const found = baseDocs.find((d) => d.id === id);
            if (found) {
              return { exists: true, id: found.id, data: () => found.data };
            }
            return { exists: false };
          },
        };
      },
    };
  };

  return {
    collection,
  };
}

// Sample data used by tests
const sampleRootDocs = [
  {
    id: 'a1',
    data: {
      item_name_lc: 'apple',
      // intentionally has whitespace to test trimming
      image_url: ' http://a.example/img1 ',
      category_id: 'food',
    },
  },
  {
    id: 'b2',
    data: {
      item_name_lc: 'banana',
      image_urls: ['http://b.example/1', '', null],
      category_id: null,
    },
  },
  {
    id: 'sku1',
    data: {
      item_name_lc: 'milk',
      sku: '12345678',
      // no gtin
    },
  },
];

describe('routes/inventory', () => {
  let app;
  let firestore;

  beforeEach(() => {
    // Build fake firestore with a root 'inventory' collection
    firestore = createFakeFirestore({ inventory: sampleRootDocs.slice() });

    // trivial requireLogin middleware
    const requireLogin = (req, res, next) => next();

    const router = buildInventoryRouter({ firestore, requireLogin });
    app = express();
    app.use(router);
  });

  test('default browse (no query) returns rows, normalizes images, mode doc and nextCursor', async () => {
    const res = await request(app).get('/api/inventory').expect(200);

    expect(res.body).toHaveProperty('rows');
    expect(Array.isArray(res.body.rows)).toBe(true);

    // Should contain all sample docs
    const ids = res.body.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['a1', 'b2', 'sku1'].sort());

    // Check image normalization for a1 (image_url trimmed -> image_urls [trimmed])
    const a1 = res.body.rows.find((r) => r.id === 'a1');
    expect(a1.image_urls).toEqual(['http://a.example/img1']);
    expect(a1.image_url).toBe('http://a.example/img1');

    // Check image_urls for b2 filtered of falsy entries
    const b2 = res.body.rows.find((r) => r.id === 'b2');
    expect(b2.image_urls).toEqual(['http://b.example/1']);
    expect(b2.image_url).toBe('http://b.example/1');

    expect(res.body.mode).toBe('doc');
    expect(res.body.onlyNoCategory).toBe(false);

    // nextCursor should be a base64-encoded JSON with mode 'doc' and id of the last doc
    expect(res.body.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(res.body.nextCursor, 'base64').toString('utf8'));
    expect(decoded).toHaveProperty('m', 'doc');
    // last doc id from our fake Query.get is the last element in sampleRootDocs
    expect(decoded).toHaveProperty('id', sampleRootDocs[sampleRootDocs.length - 1].id);
  });

  test('onlyNoCategory=1 returns only documents with missing/null category_id and mode no_category', async () => {
    const res = await request(app).get('/api/inventory').query({ onlyNoCategory: '1' }).expect(200);

    expect(res.body.mode).toBe('no_category');
    expect(res.body.onlyNoCategory).toBe(true);

    // Only b2 in sampleRootDocs has category_id null
    expect(res.body.rows.map((r) => r.id)).toEqual(['b2']);
  });

  test('numeric GTIN query falls back to SKU when GTIN search is empty (mode becomes sku)', async () => {
    // q is numeric and length >= 8 -> initial mode 'gtin'
    const res = await request(app).get('/api/inventory').query({ q: '12345678' }).expect(200);

    // Because our sampleRootDocs has no gtin but has sku '12345678', route should fallback to sku
    expect(res.body.mode).toBe('sku');
    expect(res.body.rows.length).toBe(1);
    expect(res.body.rows[0].id).toBe('sku1');

    // nextCursor should be present and indicate mode 'sku'
    const decoded = JSON.parse(Buffer.from(res.body.nextCursor, 'base64').toString('utf8'));
    expect(decoded.m).toBe('sku');
    expect(decoded.id).toBe('sku1');
  });
});
