const express = require('express');
const request = require('supertest');

// We will dynamically mock the comingSoon module before requiring the router.
const pathToComingSoon = '../../routes/comingSoon';
const pathToIndexPages = '../../routes/indexPages';

// Helper to create a flexible Firestore mock used across tests
function makeFirestoreMock(opts = {}) {
  const merchantsDocs = (opts.merchants || []).map(m => ({ id: m.id, data: () => m.data || {} }));
  const syncDocs = (opts.syncRuns || []).map(s => ({ data: () => s }));

  const perMerchantCounts = opts.perMerchantCounts || {};

  return {
    collection(name) {
      if (name === 'merchants') {
        return {
          get: async () => ({ docs: merchantsDocs }),
          count: () => ({ get: async () => ({ data: () => ({ count: typeof opts.merchantsCount === 'number' ? opts.merchantsCount : merchantsDocs.length }) }) }),
          doc: (id) => ({
            get: async () => {
              const found = merchantsDocs.find(d => d.id === id);
              if (!found) return { exists: false };
              return { exists: true, data: () => found.data() };
            }
          })
        };
      }

      if (name === 'inventory') {
        return {
          count: () => ({ get: async () => ({ data: () => ({ count: typeof opts.masterInventoryCount === 'number' ? opts.masterInventoryCount : 0 }) }) })
        };
      }

      if (name === 'gtinMeta') {
        return {
          count: () => ({ get: async () => ({ data: () => ({ count: typeof opts.gtinMetaCount === 'number' ? opts.gtinMetaCount : 0 }) }) })
        };
      }

      if (name === 'syncRuns') {
        return {
          orderBy: () => ({
            limit: () => ({
              get: async () => ({ docs: syncDocs })
            })
          })
        };
      }

      // generic fallback
      return {
        get: async () => ({ docs: [] }),
        count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
      };
    },
    collectionGroup(name) {
      if (name === 'inventory') {
        return {
          count: () => ({ get: async () => ({ data: () => ({ count: typeof opts.merchantInventoryCount === 'number' ? opts.merchantInventoryCount : 0 }) }) })
        };
      }
      return {
        count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) })
      };
    },
    // allow doc(...).collection('inventory').count().get()
    _docCollections: perMerchantCounts,
    // Provide a doc factory that includes collection on the doc
    doc(id) {
      return {
        get: async () => {
          // search in merchants supplied
          const m = (opts.merchants || []).find(x => x.id === id);
          if (!m) return { exists: false };
          return { exists: true, data: () => m.data || {} };
        },
        collection: (collName) => ({
          count: () => ({
            get: async () => {
              if (collName === 'inventory') {
                if (perMerchantCounts && typeof perMerchantCounts[id] !== 'undefined') {
                  const v = perMerchantCounts[id];
                  if (v && v.throw) throw new Error(v.throw);
                  return { data: () => ({ count: typeof v === 'number' ? v : 0 }) };
                }
                return { data: () => ({ count: 0 }) };
              }
              return { data: () => ({ count: 0 }) };
            }
          })
        })
      };
    }
  };
}

// Before requiring the router, mock comingSoon so router picks up the mocked version
jest.resetModules();
jest.doMock(pathToComingSoon, () => {
  // comingSoon should export a factory that returns an express handler
  return (title) => (req, res) => res.send(`coming soon: ${title}`);
});

const buildIndexPagesRouter = require(pathToIndexPages);

describe('routes/indexPages', () => {
  let app;

  beforeEach(() => {
    app = express();

    // Override res.render to return JSON so we can assert on what would be rendered
    app.use((req, res, next) => {
      res.render = (view, opts) => res.json({ view, opts });
      next();
    });
  });

  test('GET / redirects to /login', async () => {
    const firestore = makeFirestoreMock();
    const requireLogin = (req, res, next) => next();

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /reorder uses comingSoon and requireLogin', async () => {
    const firestore = makeFirestoreMock();
    let loginCalled = false;
    const requireLogin = (req, res, next) => { loginCalled = true; next(); };

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/reorder');
    expect(loginCalled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.text).toBe('coming soon: Reorder Recommendations');
  });

  test('GET /dashboard renders merchants from firestore', async () => {
    const firestore = makeFirestoreMock({ merchants: [ { id: 'm1', data: { business_name: 'M1' } }, { id: 'm2', data: { business_name: 'M2' } } ] });
    const requireLogin = (req, res, next) => { req.user = { id: 'u1' }; next(); };

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('dashboard');
    expect(res.body.opts.merchants).toEqual([
      { id: 'm1', business_name: 'M1' },
      { id: 'm2', business_name: 'M2' }
    ]);
    expect(res.body.opts.pageTitle).toBe('Inventory Dashboard');
  });

  test('GET /dashboard/:merchantId returns 404 when merchant missing', async () => {
    const firestore = makeFirestoreMock({ merchants: [ { id: 'm1', data: { business_name: 'M1' } } ] });
    const requireLogin = (req, res, next) => next();

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/dashboard/nonexistent');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Merchant nonexistent not found');
  });

  test('GET /dashboard/:merchantId renders merchant when exists', async () => {
    const firestore = makeFirestoreMock({ merchants: [ { id: 'm1', data: { business_name: 'M1' } }, { id: 'm2', data: { business_name: 'M2' } } ] });
    const requireLogin = (req, res, next) => next();

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/dashboard/m1');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('dashboard');
    expect(res.body.opts.merchantId).toBe('m1');
    expect(res.body.opts.merchant).toEqual({ business_name: 'M1' });
  });

  test('GET /reports collects counts and per-merchant lite counts', async () => {
    const firestore = makeFirestoreMock({
      merchants: [ { id: 'ma', data: { business_name: 'Alpha' } }, { id: 'mb', data: { business_name: 'Beta' } } ],
      merchantsCount: 2,
      masterInventoryCount: 100,
      merchantInventoryCount: 60,
      gtinMetaCount: 5,
      perMerchantCounts: { ma: 10, mb: 50 },
      syncRuns: [ { runAt: 1, name: 'r1' }, { runAt: 2, name: 'r2' } ]
    });

    const requireLogin = (req, res, next) => { req.user = { id: 'u1' }; next(); };

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/reports');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('reports');
    const opts = res.body.opts;
    expect(opts.lite).toBe(true);
    expect(opts.metrics.totalMerchants).toBe(2);
    expect(opts.metrics.masterInventoryCount).toBe(100);
    expect(opts.metrics.merchantInventoryCount).toBe(60);
    expect(opts.metrics.gtinMetaCount).toBe(5);
    // perMerchantLite should include both merchants
    const sorted = opts.metrics.perMerchantLite.sort((a,b) => a.merchantId.localeCompare(b.merchantId));
    expect(sorted).toEqual([
      { merchantId: 'ma', merchantName: 'Alpha', inventoryDocCount: 10 },
      { merchantId: 'mb', merchantName: 'Beta', inventoryDocCount: 50 }
    ]);
    // syncRuns passed through
    expect(Array.isArray(opts.syncRuns)).toBe(true);
    expect(opts.activePage).toBe('reports');
    expect(opts.user).toEqual({ id: 'u1' });
    expect(typeof opts.generatedAt).toBe('string');
  });

  test('GET /duplicates-gtin builds display names from various fields', async () => {
    const merchants = [
      { id: 'a', data: { merchant_name: 'MN' } },
      { id: 'b', data: { business_name: 'BN' } },
      { id: 'c', data: { name: 'N' } },
      { id: 'd', data: { store_name: 'SN' } },
      { id: 'e', data: {} }
    ];
    const firestore = makeFirestoreMock({ merchants });
    const requireLogin = (req, res, next) => next();

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res = await request(app).get('/duplicates-gtin');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('duplicates_gtin');
    expect(res.body.opts.merchants).toEqual([
      { id: 'a', business_name: 'MN' },
      { id: 'b', business_name: 'BN' },
      { id: 'c', business_name: 'N' },
      { id: 'd', business_name: 'SN' },
      { id: 'e', business_name: 'e' }
    ]);
  });

  test('GET /categories and /category-matrix render pages with merchants', async () => {
    const firestore = makeFirestoreMock({ merchants: [ { id: 'm1', data: { business_name: 'M1' } } ] });
    const requireLogin = (req, res, next) => next();

    const router = buildIndexPagesRouter({ firestore, requireLogin });
    app.use('/', router);

    const res1 = await request(app).get('/categories');
    expect(res1.status).toBe(200);
    expect(res1.body.view).toBe('categories');
    expect(res1.body.opts.merchants).toEqual([{ id: 'm1', business_name: 'M1' }]);

    const res2 = await request(app).get('/category-matrix');
    expect(res2.status).toBe(200);
    expect(res2.body.view).toBe('category-matrix');
    expect(res2.body.opts.merchants).toEqual([{ id: 'm1', business_name: 'M1' }]);
  });
});
