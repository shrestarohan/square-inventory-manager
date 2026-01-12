const request = require('supertest');
const express = require('express');

const buildSquareCategoriesRouter = require('../../routes/squareCategories');

// Helper to build a simple chainable Firestore-like mock
function makeFirestoreMock(docsOrThrow) {
  const docs = Array.isArray(docsOrThrow) ? docsOrThrow : [];

  function Query(initialDocs) {
    this._docs = initialDocs || [];
    this._filters = [];
  }

  Query.prototype.where = function (field, op, value) {
    this._filters.push({ field, op, value });
    return this;
  };

  Query.prototype.get = async function () {
    if (typeof docsOrThrow === 'function') {
      // allow passing a function that throws to simulate errors
      return docsOrThrow();
    }

    let rows = this._docs.slice();

    for (const f of this._filters) {
      if (f.op === '==') {
        rows = rows.filter(r => {
          // treat undefined as undefined to mimic Firestore behavior loosely
          return (r[f.field] === f.value);
        });
      } else {
        // unsupported op in these tests
      }
    }

    return {
      docs: rows.map(d => ({ data: () => d }))
    };
  };

  return {
    collection(name) {
      // collection name ignored for tests, return Query seeded with docs
      return new Query(docs);
    }
  };
}

describe('routes/squareCategories', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('responds 400 when merchantId is missing and runs requireLogin', async () => {
    const requireLogin = jest.fn((req, res, next) => next());
    const firestore = makeFirestoreMock([]);

    const app = express();
    app.use(buildSquareCategoriesRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/square-categories');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'merchantId required' });
    expect(requireLogin).toHaveBeenCalled();
  });

  test('returns rows for merchantId and filters by q (case-insensitive)', async () => {
    const docs = [
      { merchant_id: 'm1', is_deleted: false, category_name: 'Foo Bar', extra: 1 },
      { merchant_id: 'm1', is_deleted: false, category_name: 'Other', extra: 2 },
      { merchant_id: 'm1', is_deleted: true, category_name: 'Deleted', extra: 3 },
      { merchant_id: 'm2', is_deleted: false, category_name: 'Foo m2', extra: 4 },
      { merchant_id: 'm1', is_deleted: false /* no category_name */ , extra: 5 }
    ];

    const firestore = makeFirestoreMock(docs);
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildSquareCategoriesRouter({ firestore, requireLogin }));

    // case: no q => return all non-deleted m1 rows
    const resAll = await request(app).get('/api/square-categories').query({ merchantId: 'm1' });
    expect(resAll.status).toBe(200);
    expect(Array.isArray(resAll.body.rows)).toBe(true);
    // Should include 3 docs: Foo Bar, Other, and the one without category_name (Deleted is is_deleted true)
    expect(resAll.body.rows.length).toBe(3);

    // case: q filters case-insensitively
    const resQ = await request(app).get('/api/square-categories').query({ merchantId: 'm1', q: 'foo' });
    expect(resQ.status).toBe(200);
    expect(Array.isArray(resQ.body.rows)).toBe(true);
    // Only 'Foo Bar' matches 'foo' for merchant m1
    expect(resQ.body.rows.length).toBe(1);
    expect(resQ.body.rows[0].category_name).toBe('Foo Bar');
  });

  test('returns 500 when Firestore get throws', async () => {
    const requireLogin = jest.fn((req, res, next) => next());

    // make get throw
    const firestore = {
      collection() {
        return {
          where() { return this; },
          async get() {
            throw new Error('boom-firestore');
          }
        };
      }
    };

    const app = express();
    app.use(buildSquareCategoriesRouter({ firestore, requireLogin }));

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/square-categories').query({ merchantId: 'm1' });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/boom-firestore/);
    expect(errSpy).toHaveBeenCalled();
  });
});
