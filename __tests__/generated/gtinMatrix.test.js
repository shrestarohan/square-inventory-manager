const express = require('express');
const request = require('supertest');
const buildGtinMatrixRouter = require('../../routes/gtinMatrix');

// Helper to create a fake Firestore collection that supports
// the minimal APIs used by the router: orderBy, where, limit,
// startAt, endAt, startAfter, get, doc().get
function makeFakeFirestore(docsMap) {
  // docsMap: { id: data }
  const baseDocs = Object.keys(docsMap).sort().map((id) => ({ id, data: () => docsMap[id] }));

  function makeCol() {
    // internal query state
    const state = {
      orderBys: [], // [{ field, dir }]
      whereClauses: [], // [{ field, op, value }]
      startAtId: null,
      endAtId: null,
      startAfterId: null,
      limitCount: null,
    };

    const col = {
      // chainable methods
      orderBy(field, dir = 'asc') {
        state.orderBys.push({ field, dir });
        return col;
      },
      where(field, op, value) {
        state.whereClauses.push({ field, op, value });
        return col;
      },
      startAt(value) {
        // used with __name__ only in tested code; value is an id string
        state.startAtId = value;
        return col;
      },
      endAt(value) {
        state.endAtId = value;
        return col;
      },
      startAfter(docSnapshot) {
        // docSnapshot may be an object with id
        state.startAfterId = docSnapshot && docSnapshot.id ? docSnapshot.id : docSnapshot;
        return col;
      },
      limit(n) {
        state.limitCount = n;
        return col;
      },
      async get() {
        // Build the result based on state
        let rows = baseDocs.slice();

        // Apply where clauses (only variation_count comparisons needed)
        for (const where of state.whereClauses) {
          if (where.field === 'variation_count') {
            if (where.op === '>') {
              rows = rows.filter((d) => Number((docsMap[d.id] || {}).variation_count || 0) > where.value);
            }
          }
        }

        // Apply startAt/endAt (on doc id / __name__)
        if (state.startAtId !== null) {
          rows = rows.filter((d) => d.id >= state.startAtId);
        }
        if (state.endAtId !== null) {
          rows = rows.filter((d) => d.id <= state.endAtId);
        }

        // Apply startAfterId (skip docs up to and including that id)
        if (state.startAfterId !== null) {
          rows = rows.filter((d) => d.id > state.startAfterId);
        }

        // Apply ordering
        if (state.orderBys.length > 0) {
          // we'll implement two simple orderers used in the code:
          // - orderBy('__name__') => sort by id
          // - orderBy('variation_count','desc') followed by orderBy('__name__')
          const ob = state.orderBys[0];
          if (ob.field === 'variation_count') {
            // primary sort by variation_count desc, secondary by id asc if provided
            rows.sort((a, b) => {
              const av = Number((docsMap[a.id] || {}).variation_count || 0);
              const bv = Number((docsMap[b.id] || {}).variation_count || 0);
              if (av === bv) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
              // desc
              return bv - av;
            });
          } else if (ob.field === '__name__') {
            rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          }
        }

        // Apply limit
        let sliced = rows;
        if (state.limitCount != null) sliced = sliced.slice(0, state.limitCount);

        // Return a snapshot-like object
        const docs = sliced.map((d) => ({ id: d.id, data: d.data }));
        return {
          docs,
          size: docs.length,
          empty: docs.length === 0,
        };
      },

      // doc access
      doc(id) {
        return {
          async get() {
            const exists = Object.prototype.hasOwnProperty.call(docsMap, id);
            return {
              exists,
              id,
              data: () => (exists ? docsMap[id] : undefined),
            };
          },
        };
      },
    };

    return col;
  }

  // Firestore root mock: collection(name).doc(mid).collection(name2)
  return {
    collection(name) {
      return {
        doc(merchantId) {
          return {
            collection(name2) {
              // For this test, name2 is 'gtin_matrix' and we ignore name and merchantId
              return makeCol();
            },
          };
        },
      };
    },
  };
}

function makeAppWithDocs(docsMap) {
  const firestore = makeFakeFirestore(docsMap);
  const requireLogin = (req, res, next) => next();
  const router = buildGtinMatrixRouter({ requireLogin, firestore });
  const app = express();
  app.use(router);
  return app;
}

describe('/api/gtin-matrix', () => {
  test('returns 400 when merchantId missing', async () => {
    const app = makeAppWithDocs({});
    const res = await request(app).get('/api/gtin-matrix');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'merchantId required' });
  });

  test('doc-id mode default returns rows and nextCursor', async () => {
    // three docs: ids sorted
    const docs = {
      '0001': { canonical_name: 'A', variation_count: 1, variations: {} },
      '0002': { canonical_name: 'B', variation_count: 2, variations: {} },
      '0003': { canonical_name: 'C', variation_count: 3, variations: {} },
    };

    const app = makeAppWithDocs(docs);
    const res = await request(app).get('/api/gtin-matrix').query({ merchantId: 'm1' });
    expect(res.status).toBe(200);
    // rows should be all three in id order
    expect(res.body.rows.map((r) => r.gtin)).toEqual(['0001', '0002', '0003']);
    // nextCursor should be last doc id
    expect(res.body.nextCursor).toBe('0003');
    expect(res.body.locations).toEqual([]);
  });

  test('onlyDuplicates without q filters and orders by variation_count desc', async () => {
    const docs = {
      'a': { canonical_name: 'aa', variation_count: 1, variations: {} },
      'b': { canonical_name: 'bb', variation_count: 5, variations: {} },
      'c': { canonical_name: 'cc', variation_count: 2, variations: {} },
    };
    const app = makeAppWithDocs(docs);
    const res = await request(app)
      .get('/api/gtin-matrix')
      .query({ merchantId: 'm1', onlyDuplicates: '1' });
    expect(res.status).toBe(200);
    // should include only b and c (variation_count > 1), ordered by variation_count desc
    expect(res.body.rows.map((r) => r.gtin)).toEqual(['b', 'c']);
    expect(res.body.rows[0].variation_count).toBe(5);
    expect(res.body.rows[1].variation_count).toBe(2);
  });

  test('GTIN exact numeric search (doc id) returns only the matching doc; onlyDuplicates post-filtering works', async () => {
    const docs = {
      '12345678': { canonical_name: 'match', variation_count: 1, variations: {} },
      '87654321': { canonical_name: 'other', variation_count: 2, variations: {} },
    };
    const app = makeAppWithDocs(docs);

    // search exact id that has variation_count 1 but onlyDuplicates=1 -> should be filtered out
    const res1 = await request(app)
      .get('/api/gtin-matrix')
      .query({ merchantId: 'm1', q: '12345678', onlyDuplicates: '1' });
    expect(res1.status).toBe(200);
    expect(res1.body.rows).toEqual([]);

    // search exact id without onlyDuplicates -> returns the doc
    const res2 = await request(app)
      .get('/api/gtin-matrix')
      .query({ merchantId: 'm1', q: '12345678' });
    expect(res2.status).toBe(200);
    expect(res2.body.rows.length).toBe(1);
    expect(res2.body.rows[0].gtin).toBe('12345678');
  });

  test('scan mode searches canonical_name, variations item_name and sku', async () => {
    const docs = {
      'g1': {
        canonical_name: 'Delicious Foo Bar',
        variation_count: 1,
        variations: {
          v1: { item_name: 'Small', sku: 'sku-small' },
        },
      },
      'g2': {
        canonical_name: 'Unrelated',
        variation_count: 1,
        variations: {
          v1: { item_name: 'Fooish', sku: 'sku-foo' },
        },
      },
      'g3': {
        canonical_name: 'Nothing',
        variation_count: 1,
        variations: {
          v1: { item_name: 'Other', sku: 'other-sku' },
        },
      },
    };
    const app = makeAppWithDocs(docs);

    // q is non-digit -> scan mode. Searching for "foo" should match g1 (canonical) and g2 (variation item_name/sku)
    const res = await request(app)
      .get('/api/gtin-matrix')
      .query({ merchantId: 'm1', q: 'foo' });
    expect(res.status).toBe(200);
    const ids = res.body.rows.map((r) => r.gtin).sort();
    expect(ids).toEqual(['g1', 'g2']);
  });

  test('docId pagination with cursor returns next page', async () => {
    const docs = {
      '001': { canonical_name: 'A', variation_count: 1, variations: {} },
      '002': { canonical_name: 'B', variation_count: 1, variations: {} },
      '003': { canonical_name: 'C', variation_count: 1, variations: {} },
    };
    const app = makeAppWithDocs(docs);

    // Request first page with pageSize=2
    const res1 = await request(app)
      .get('/api/gtin-matrix')
      .query({ merchantId: 'm1', pageSize: '2' });
    expect(res1.status).toBe(200);
    expect(res1.body.rows.map((r) => r.gtin)).toEqual(['001', '002']);
    expect(res1.body.nextCursor).toBe('002');

    // Request second page with cursor
    const res2 = await request(app)
      .get('/api/gtin-matrix')
      .query({ merchantId: 'm1', pageSize: '2', cursor: res1.body.nextCursor });
    expect(res2.status).toBe(200);
    // should return remaining doc(s)
    expect(res2.body.rows.map((r) => r.gtin)).toEqual(['003']);
  });
});
