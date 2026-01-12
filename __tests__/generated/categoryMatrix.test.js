const request = require('supertest');
const express = require('express');
const buildCategoryMatrixRouter = require('../../routes/categoryMatrix');

// Helper to build a fake Firestore-like object
function makeFirestoreMock({ merchants = [], categories = [], throwOnGet = false } = {}) {
  return {
    collection(name) {
      return {
        async get() {
          if (throwOnGet) throw new Error('boom');
          if (name === 'merchants') {
            return {
              docs: merchants.map(m => ({ id: m.id, data: () => m.data }))
            };
          }
          if (name === 'square_categories') {
            return {
              docs: categories.map(c => ({ id: c.id || `${c.merchant_id || 'x'}_${c.category_id || 'cat'}`, data: () => c }))
            };
          }
          // default empty
          return { docs: [] };
        }
      };
    }
  };
}

describe('routes/categoryMatrix', () => {
  test('returns merchants and rows with missingCount, nameMismatch and sorted order', async () => {
    const merchants = [
      { id: 'm1', data: { business_name: 'Merchant One' } },
      { id: 'm2', data: { /* no business_name */ } },
    ];

    const categories = [
      // Coffee present on both merchants -> no mismatch
      { merchant_id: 'm1', category_id: 'cat1', category_name: 'Coffee', fetched_at: '2021-01-01', is_deleted: false },
      { merchant_id: 'm2', category_id: 'cat2', category_name: 'Coffee', fetched_at: '2021-02-02', is_deleted: false },

      // Tea only on m1 -> missingCount 1
      { merchant_id: 'm1', category_id: 'cat3', category_name: 'Tea', fetched_at: null, is_deleted: false },

      // Acme variation: both merchants but different names that normalize to same key -> nameMismatch true
      { merchant_id: 'm1', category_id: 'cat6', category_name: 'Acme, Inc.', fetched_at: null, is_deleted: false },
      { merchant_id: 'm2', category_id: 'cat7', category_name: 'Acme Inc', fetched_at: null, is_deleted: false },

      // deleted category should be ignored
      { merchant_id: 'm2', category_id: 'cat_del', category_name: 'DeletedCat', is_deleted: true },
    ];

    const firestore = makeFirestoreMock({ merchants, categories });

    const requireLogin = (req, res, next) => next();
    const app = express();
    app.use(buildCategoryMatrixRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/category-matrix').expect(200);

    expect(res.body).toHaveProperty('merchants');
    expect(res.body).toHaveProperty('rows');

    // merchants: name fallback to id when business_name missing
    expect(res.body.merchants).toEqual([
      { id: 'm1', name: 'Merchant One' },
      { id: 'm2', name: 'm2' },
    ]);

    const rows = res.body.rows;
    // We expect three keys (tea, acme inc, coffee) because DeletedCat was filtered
    // Order: missingCount desc (tea has missing), then nameMismatch (acme inc), then coffee
    const keys = rows.map(r => r.category_key);
    expect(keys).toEqual(['tea', 'acme inc', 'coffee']);

    const byKey = rows.reduce((acc, r) => { acc[r.category_key] = r; return acc; }, {});

    // tea: present on only m1
    expect(byKey['tea'].presentCount).toBe(1);
    expect(byKey['tea'].missingCount).toBe(1);
    expect(byKey['tea'].nameMismatch).toBe(false);

    // acme inc: present on both, but names differ ("Acme, Inc." vs "Acme Inc") => nameMismatch true
    expect(byKey['acme inc'].presentCount).toBe(2);
    expect(byKey['acme inc'].missingCount).toBe(0);
    expect(byKey['acme inc'].nameMismatch).toBe(true);

    // coffee: present on both, same names -> no mismatch
    expect(byKey['coffee'].presentCount).toBe(2);
    expect(byKey['coffee'].missingCount).toBe(0);
    expect(byKey['coffee'].nameMismatch).toBe(false);

    // Ensure byMerchant entries exist and include fetched_at when provided
    expect(byKey['coffee'].byMerchant.m1.category_id).toBe('cat1');
    expect(byKey['coffee'].byMerchant.m1.fetched_at).toBe('2021-01-01');
    expect(byKey['coffee'].byMerchant.m2.category_id).toBe('cat2');
    expect(byKey['coffee'].byMerchant.m2.fetched_at).toBe('2021-02-02');
  });

  test('applies q filter (normalized) to only return matching rows', async () => {
    const merchants = [
      { id: 'm1', data: { business_name: 'Merchant One' } },
      { id: 'm2', data: {} },
    ];

    const categories = [
      { merchant_id: 'm1', category_id: 'cat1', category_name: 'Coffee', is_deleted: false },
      { merchant_id: 'm2', category_id: 'cat2', category_name: 'Coffee', is_deleted: false },
      { merchant_id: 'm1', category_id: 'cat3', category_name: 'Tea', is_deleted: false },
    ];

    const firestore = makeFirestoreMock({ merchants, categories });
    const requireLogin = (req, res, next) => next();
    const app = express();
    app.use(buildCategoryMatrixRouter({ firestore, requireLogin }));

    // Query q=cof should match 'coffee'
    const res = await request(app).get('/api/category-matrix').query({ q: 'cof' }).expect(200);
    expect(res.body.rows.map(r => r.category_key)).toEqual(['coffee']);
  });

  test('returns 500 when firestore throws', async () => {
    const firestore = makeFirestoreMock({ throwOnGet: true });
    const requireLogin = (req, res, next) => next();
    const app = express();
    app.use(buildCategoryMatrixRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/category-matrix').expect(500);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
  });
});
