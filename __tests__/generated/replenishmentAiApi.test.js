const request = require('supertest');
const express = require('express');

// Helper to build a fake Firestore with just-enough behavior for the router
function makeFakeFirestore({ salesEntries = [], inventoryDocs = [] } = {}) {
  const writes = [];

  function makeSnapshotFromArray(arr) {
    return {
      empty: arr.length === 0,
      size: arr.length,
      docs: arr.map((d) => ({ data: () => d }))
    };
  }

  // Collections and docs are very light-weight; chainable methods return
  // objects that match the usage in the route file.
  function Collection(pathParts) {
    const self = {
      pathParts,
      doc(id) {
        return Doc(pathParts.concat([`doc:${id}`]));
      }
    };

    // For inventory top-level collection -> .get()
    self.get = async () => {
      // Only return inventory docs when collection is named 'inventory'
      if (pathParts[pathParts.length - 1] === 'inventory') {
        return makeSnapshotFromArray(inventoryDocs);
      }
      // Default empty
      return makeSnapshotFromArray([]);
    };

    // For sales_lines_month/<monthId>/collection('lines') we return an object
    // that supports orderBy().limit().startAfter().get()
    self.orderBy = function () {
      return this;
    };
    self.limit = function () {
      return this;
    };
    self.startAfter = function () {
      return this;
    };
    self.get = async function () {
      // If the path ends with 'lines', we should return sales entries.
      if (pathParts[pathParts.length - 1] === 'lines') {
        // We expect the month id to be one of the pathParts previously
        // e.g. ['merchants','doc:mid','sales_lines_month','doc:2026-01','lines']
        // extract doc:... just before 'lines'
        const monthDocPart = pathParts[pathParts.length - 2] || '';
        const monthId = (monthDocPart.startsWith('doc:') ? monthDocPart.slice(4) : monthDocPart);
        // If we have sales mapped by monthId, return them, otherwise return the global salesEntries
        const entries = (salesMap[monthId] || salesEntries || []);
        return makeSnapshotFromArray(entries);
      }
      return makeSnapshotFromArray([]);
    };

    return self;
  }

  function Doc(pathParts) {
    return {
      collection(name) {
        return Collection(pathParts.concat([name]));
      },
      async set(data, opts) {
        writes.push({ path: pathParts.slice(), data, opts });
        return Promise.resolve();
      }
    };
  }

  // sales entries may be provided per-month via salesMap, or use fallback salesEntries
  const salesMap = {};

  return {
    _writes: writes,
    _salesMap: salesMap,
    collection(name) {
      return Collection([name]);
    },
    // helper to seed per-month sales
    seedMonth(monthId, docs) {
      salesMap[monthId] = docs;
    }
  };
}

// We'll use jest's module isolation and mocking to replace OpenAI before loading the router
describe('routes/replenishmentAiApi', () => {
  let OpenAIMockConstructor;
  let openaiCreateMock;

  beforeEach(() => {
    // reset env
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-5-mini';

    // Re-mock the module fresh in each test case
    jest.resetModules();

    // Provide a mock OpenAI constructor that returns an object with responses.create
    openaiCreateMock = jest.fn();

    OpenAIMockConstructor = function () {
      return { responses: { create: openaiCreateMock } };
    };

    // Attach the inner mock so tests can configure it after require
    OpenAIMockConstructor.__createMock = openaiCreateMock;

    jest.doMock('openai', () => OpenAIMockConstructor);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    jest.resetAllMocks();
  });

  test('POST /api/replenishment-ai/plan - success: builds snapshot, calls OpenAI, saves plan', async () => {
    // isolate modules and require router after openai is mocked
    let buildRouter;
    jest.isolateModules(() => {
      buildRouter = require('../../routes/replenishmentAiApi');
    });

    // Build fake firestore. Provide sales entries so soldByVar has data and inventory with a stockout
    const inventoryDocs = [
      {
        variation_id: 'v1',
        item_id: 'i1',
        sku: 'SKU1',
        on_hand: 0,
        price: 20,
        unit_cost: null,
        item_name: 'Test Item 1',
        category_name: 'Cat',
        vendor: 'VendCo'
      }
    ];

    const salesEntry = {
      variation_id: 'v1',
      qty: 30,
      gross_sales: 600
    };

    const firestore = makeFakeFirestore({ salesEntries: [salesEntry], inventoryDocs });
    // Also seed an arbitrary month key so buildSnapshot gets some data in whichever months it iterates
    const anyMonthId = new Date().toISOString().slice(0, 7); // e.g. '2026-01'
    firestore.seedMonth(anyMonthId, [salesEntry]);

    const requireLogin = (req, res, next) => next();

    const router = buildRouter({ firestore, requireLogin });

    const app = express();
    app.use(express.json());
    app.use(router);

    // Configure OpenAI mock to return a JSON string in output_text
    const fakePlan = { summary: { merchantId: 'm1', days: 84, targetDays: 21, budget: null, maxLines: 300, estimatedTotalCost: 0, lineCount: 0 }, vendorBuckets: [], watchlist: [] };
    openaiCreateMock.mockResolvedValueOnce({ output_text: JSON.stringify(fakePlan) });

    const resp = await request(app)
      .post('/api/replenishment-ai/plan')
      .send({ merchantId: 'm1' })
      .set('Accept', 'application/json');

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.plan).toBeDefined();
    expect(resp.body.plan.summary).toBeDefined();
    expect(resp.body.plan.summary.merchantId).toBe('m1');

    // Ensure Firestore set was called to save latest plan
    const writes = firestore._writes;
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const lastWrite = writes[writes.length - 1];
    // lastWrite.path should include 'merchants' and 'doc:m1' and 'ai_replenishment_plans'
    const pathStr = lastWrite.path.join('/');
    expect(pathStr).toContain('merchants');
    expect(pathStr).toContain('doc:m1');
    expect(pathStr).toContain('ai_replenishment_plans');
  });

  test('POST /api/replenishment-ai/audit - success: calls OpenAI and saves audit', async () => {
    let buildRouter;
    jest.isolateModules(() => {
      buildRouter = require('../../routes/replenishmentAiApi');
    });

    // Provide inventory with a zero-on-hand item
    const inventoryDocs = [
      {
        variation_id: 'a1',
        item_id: 'ia1',
        sku: 'ASKU',
        on_hand: 0,
        price: 10,
        unit_cost: 6,
        item_name: 'Audit Item',
        category_name: 'CatA',
        vendor: 'VendorA'
      }
    ];

    const salesEntry = {
      variation_id: 'a1',
      qty: 5,
      gross_sales: 50
    };

    const firestore = makeFakeFirestore({ salesEntries: [salesEntry], inventoryDocs });
    const anyMonthId = new Date().toISOString().slice(0, 7);
    firestore.seedMonth(anyMonthId, [salesEntry]);

    const requireLogin = (req, res, next) => next();
    const router = buildRouter({ firestore, requireLogin });

    const app = express();
    app.use(express.json());
    app.use(router);

    const fakeAudit = { summary: { merchantId: 'm2', days: 84, generatedAt: new Date().toISOString(), zeroCount: 1, removeCandidateCount: 0 }, zeroOnHandRatings: [], removeOrDeactivate: [] };
    openaiCreateMock.mockResolvedValueOnce({ output_text: JSON.stringify(fakeAudit) });

    const resp = await request(app)
      .post('/api/replenishment-ai/audit')
      .send({ merchantId: 'm2' })
      .set('Accept', 'application/json');

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.audit).toBeDefined();
    expect(resp.body.audit.summary.merchantId).toBe('m2');

    // Ensure audit saved
    const writes = firestore._writes;
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const pathStr = writes[writes.length - 1].path.join('/');
    expect(pathStr).toContain('ai_replenishment_audits');
  });

  test('POST /api/replenishment-ai/plan - OpenAI quota error -> 429', async () => {
    let buildRouter;
    jest.isolateModules(() => {
      buildRouter = require('../../routes/replenishmentAiApi');
    });

    const firestore = makeFakeFirestore({ salesEntries: [], inventoryDocs: [] });
    const requireLogin = (req, res, next) => next();
    const router = buildRouter({ firestore, requireLogin });
    const app = express();
    app.use(express.json());
    app.use(router);

    // Configure OpenAI mock to throw a quota error
    const quotaErr = new Error('You have exceeded your current quota');
    quotaErr.status = 429;
    openaiCreateMock.mockRejectedValueOnce(quotaErr);

    const resp = await request(app)
      .post('/api/replenishment-ai/plan')
      .send({ merchantId: 'm3' })
      .set('Accept', 'application/json');

    expect(resp.status).toBe(429);
    expect(resp.body.ok).toBe(false);
    expect(resp.body.code).toBe('OPENAI_QUOTA_EXCEEDED');
  });

  test('POST /api/replenishment-ai/plan - missing merchantId -> 400', async () => {
    let buildRouter;
    jest.isolateModules(() => {
      buildRouter = require('../../routes/replenishmentAiApi');
    });

    const firestore = makeFakeFirestore({});
    const requireLogin = (req, res, next) => next();
    const router = buildRouter({ firestore, requireLogin });
    const app = express();
    app.use(express.json());
    app.use(router);

    const resp = await request(app)
      .post('/api/replenishment-ai/plan')
      .send({})
      .set('Accept', 'application/json');

    expect(resp.status).toBe(400);
    expect(resp.body.ok).toBe(false);
    expect(resp.body.error).toBe('Missing merchantId');
  });
});
