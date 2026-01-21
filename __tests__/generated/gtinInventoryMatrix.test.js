const request = require('supertest');
const express = require('express');
const buildRouter = require('../../routes/gtinInventoryMatrix');

// Minimal Firestore query/snapshot mocks tailored to the router's needs
function createFirestore({ gtinDocsByMerchant = {}, locationIndexByMerchant = {} } = {}) {
  function makeDocSnapshot(doc) {
    return {
      id: doc.id,
      data: () => doc.data || {}
    };
  }

  function makeCollectionRef(merchantId, collectionName) {
    if (collectionName === 'location_index') {
      const locDocs = (locationIndexByMerchant[merchantId] || []).map(d => ({ id: d.id, data: () => d }));
      return {
        get: async () => ({ docs: locDocs, size: locDocs.length, empty: locDocs.length === 0 })
      };
    }

    // gtin_inventory_matrix collection
    const docs = (gtinDocsByMerchant[merchantId] || []).map(d => ({ id: d.id, data: () => d.data || {} }));

    // Query constructor closure
    function Query({ startAtValue = null, endAtValue = null, limitValue = null, startAfterIndex = null } = {}) {
      const q = {
        startAt(value) {
          return Query({ ...arguments[0], startAtValue: value });
        },
        endAt(value) {
          return Query({ ...arguments[0], endAtValue: value });
        },
        limit(n) {
          return Query({ ...arguments[0], limitValue: n });
        },
        startAfter(cursorDoc) {
          // cursorDoc is the result of colRef.doc(id).get()
          const idx = docs.findIndex(d => d.id === (cursorDoc && cursorDoc.id));
          const nextIndex = idx >= 0 ? idx + 1 : 0;
          return Query({ startAfterIndex: nextIndex });
        },
        async get() {
          // Build list according to startAt/endAt or startAfter
          let selected = docs.slice();

          if (startAtValue !== null || endAtValue !== null) {
            const s = startAtValue !== null ? startAtValue : undefined;
            const e = endAtValue !== null ? endAtValue : undefined;
            selected = selected.filter(d => {
              if (s !== undefined && e !== undefined) {
                // inclusive between s and e (string compare OK for test ids)
                return d.id >= s && d.id <= e;
              }
              if (s !== undefined) return d.id >= s;
              if (e !== undefined) return d.id <= e;
              return true;
            });
          }

          if (startAfterIndex !== null) {
            selected = selected.slice(startAfterIndex);
          }

          if (limitValue !== null) {
            selected = selected.slice(0, limitValue);
          }

          const snapDocs = selected.map(makeDocSnapshot);
          return { docs: snapDocs, size: snapDocs.length, empty: snapDocs.length === 0 };
        }
      };
      return q;
    }

    return {
      orderBy() {
        // returns a fresh Query state
        return Query();
      },
      doc(id) {
        return {
          async get() {
            const found = docs.find(d => d.id === id);
            if (found) return { exists: true, id: found.id, data: () => found.data || {} };
            return { exists: false };
          }
        };
      }
    };
  }

  return {
    collection(name) {
      return {
        doc: (docId) => {
          // Only merchants collection has doc() followed by collection()
          // We'll return an object that has collection for merchant docs
          return {
            collection: (subName) => makeCollectionRef(docId, subName)
          };
        },
        // For direct access to merchants/<merchantId>/location_index: router does firestore.collection('merchants').doc(merchantId).collection('location_index').get();
        // This top-level collection() is primarily used to get a doc(merchantId) as above.
      };
    }
  };
}

describe('routes/gtinInventoryMatrix', () => {
  let app;
  const requireLogin = (req, res, next) => next();

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  test('returns 400 when merchantId missing', async () => {
    const firestore = createFirestore();
    const router = buildRouter({ requireLogin, firestore });
    app.use(router);

    const res = await request(app).get('/api/duplicates-inventory-matrix');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'merchantId required' });
  });

  test('docId mode: digit query (>=8) returns matching doc and locations sorted', async () => {
    const merchantId = 'm1';

    const gtinDocsByMerchant = {
      [merchantId]: [
        { id: '00000001', data: { item_name: 'Widget A', sku: 'WID-A' } },
        { id: '12345678', data: { item_name_lc: 'special item', sku: 'SPEC-1' } },
        { id: '99999999', data: { item_name: 'Other', sku: 'OTH' } }
      ]
    };

    const locationIndexByMerchant = {
      [merchantId]: [ { id: 'l1', locKey: 'b' }, { id: 'l2', locKey: 'a' } ]
    };

    const firestore = createFirestore({ gtinDocsByMerchant, locationIndexByMerchant });
    const router = buildRouter({ requireLogin, firestore });
    app.use(router);

    const res = await request(app)
      .get('/api/duplicates-inventory-matrix')
      .query({ merchantId, q: '12345678', pageSize: '5' })
      .expect(200);

    // Should return only the exact-matching id
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBe(1);
    expect(res.body.rows[0].gtin).toBe('12345678');
    expect(res.body.rows[0].item_name_lc).toBe('special item');

    // locations should be sorted
    expect(res.body.locations).toEqual(['a', 'b']);

    // nextCursor should be last doc id of the result set
    expect(res.body.nextCursor).toBe('12345678');
  });

  test('scan mode: non-digit query scans and filters by name/sku and respects pageSize', async () => {
    const merchantId = 'm2';
    // Three docs, two of which match 'abc' once whitespace removed
    const gtinDocsByMerchant = {
      [merchantId]: [
        { id: 'g1', data: { item_name: 'A B C', sku: 'X1' } }, // nameNorm -> 'abc' match
        { id: 'g2', data: { item_name: 'Other', sku: 'A B C' } }, // skuNorm -> 'abc' match
        { id: 'g3', data: { item_name: 'NoMatch', sku: 'ZZ' } }
      ]
    };

    const locationIndexByMerchant = {
      [merchantId]: [ { id: 'l1', locKey: 'loc1' } ]
    };

    const firestore = createFirestore({ gtinDocsByMerchant, locationIndexByMerchant });
    const router = buildRouter({ requireLogin, firestore });
    app.use(router);

    // request pageSize 2 to ensure it stops when collected reaches 2
    const res = await request(app)
      .get('/api/duplicates-inventory-matrix')
      .query({ merchantId, q: 'a b c', pageSize: '2' })
      .expect(200);

    expect(Array.isArray(res.body.rows)).toBe(true);
    // Should collect the two matching docs
    expect(res.body.rows.map(r => r.gtin).sort()).toEqual(['g1', 'g2']);

    // locations
    expect(res.body.locations).toEqual(['loc1']);

    // nextCursor in scan mode will be null in our simulated batches (batchSize != lastSnap.size)
    expect(res.body.nextCursor).toBeNull();
  });
});
