const path = require('path');

// Ensure we reset modules between tests if needed
beforeAll(() => {
  // nothing
});

// Mocks must be set up before requiring the app module
// We'll compute absolute module paths (relative to this test file) and mock them.
const fsMock = { __isMock: true, name: 'mockFirestore' };

// Mock firestore
const firestorePath = require.resolve('../../lib/firestore');
jest.mock(firestorePath, () => fsMock);

// Mock middleware/appContext to be a factory that returns real middleware
const appContextPath = require.resolve('../../middleware/appContext');
const mockAppContext = jest.fn(() => (req, res, next) => {
  // attach something to locals to make sure it runs
  res.locals._mockAppContext = true;
  next();
});
jest.mock(appContextPath, () => mockAppContext);

// Mock middleware/requireLogin to be a simple middleware function (and exportable)
const requireLoginPath = require.resolve('../../middleware/requireLogin');
const mockRequireLogin = jest.fn((req, res, next) => next());
jest.mock(requireLoginPath, () => mockRequireLogin);

// Mock lib/square exports
const squarePath = require.resolve('../../lib/square');
const mockCreateSquareOAuthClient = jest.fn(() => ({ mocked: 'oauthClient' }));
const mockCreateSquareClient = jest.fn(() => ({ mocked: 'squareClient' }));
const mockMakeCreateSquareClientForMerchant = jest.fn(() => jest.fn(() => ({ forMerchant: true })));
jest.mock(squarePath, () => ({
  createSquareOAuthClient: mockCreateSquareOAuthClient,
  createSquareClient: mockCreateSquareClient,
  makeCreateSquareClientForMerchant: mockMakeCreateSquareClientForMerchant,
}));

// Mock inventory sync and buildGtinMatrix
const inventorySyncPath = require.resolve('../../lib/inventorySync');
const mockSyncAllMerchants = jest.fn();
jest.mock(inventorySyncPath, () => ({ syncAllMerchants: mockSyncAllMerchants }));

const buildGtinPath = require.resolve('../../scripts/buildGtinMatrix');
const mockRunBuildGtinMatrix = jest.fn();
jest.mock(buildGtinPath, () => ({ runBuildGtinMatrix: mockRunBuildGtinMatrix }));

// Helper to mock many route modules. Each route module is expected to export a function
// that accepts options and returns an Express router (or middleware).
const express = require('express');
function makeRouteMock(name) {
  const fn = jest.fn((opts) => {
    // return a small router so that app.use works; expose a test-only endpoint
    const r = express.Router();
    r.get(`/__mocked_route__${name}`, (req, res) => res.json({ ok: true, route: name }));
    return r;
  });
  return fn;
}

const routeModules = [
  'auth',
  'squareOAuth',
  'tasks',
  'apiUpdates',
  'inventory',
  'gtinMeta',
  'gtinDuplicates',
  'gtinInventoryMatrixConsolidated',
  'gtinInventoryMatrix',
  'inventoryIntegrityRoutes',
  'deleteGtin',
  'itemImages',
  'copyItemInfo',
  'squareCategories',
  'categoryMatrix',
  'categoryActions',
  'categorySync',
  'categoriesRename',
  'categoriesList',
  'itemsSetCategoryId',
  'itemsUpdateFields',
  'replenishment',
  'replenishmentAiPage',
  'replenishmentAiApi',
  'indexPages',
];

const routeMocks = {};
for (const name of routeModules) {
  const modulePath = require.resolve(path.join('../../routes', name));
  const mock = makeRouteMock(name);
  routeMocks[name] = mock;
  jest.mock(modulePath, () => mock);
}

// Now set environment variables used by app.js
process.env.FIRESTORE_DATABASE_ID = 'test-db';
process.env.NODE_ENV = 'test-node-env';
process.env.APP_ENV = 'test-app-env';
process.env.SQUARE_ENV = 'test-square-env';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_CALLBACK_URL = 'https://example.com/callback';
process.env.ALLOWED_EMAILS = 'a@x.com;b@y.com;';

// Now require the app (after mocking everything)
const request = require('supertest');
const app = require('../../app');

describe('app.js basic integration', () => {
  test('creates Square OAuth client with SQUARE_ENV', () => {
    // createSquareOAuthClient should have been called exactly once with SQUARE_ENV
    expect(mockCreateSquareOAuthClient).toHaveBeenCalledTimes(1);
    expect(mockCreateSquareOAuthClient).toHaveBeenCalledWith(process.env.SQUARE_ENV || 'sandbox');
  });

  test('makeCreateSquareClientForMerchant was called with firestore', () => {
    // makeCreateSquareClientForMerchant should be called once with an object containing firestore
    expect(mockMakeCreateSquareClientForMerchant).toHaveBeenCalledTimes(1);
    // It should have been invoked with an object that has the same reference as our firestore mock
    const firstArg = mockMakeCreateSquareClientForMerchant.mock.calls[0][0];
    expect(firstArg).toEqual({ firestore: fsMock });
  });

  test('GET /healthz returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  test('GET / redirects to /login', async () => {
    const res = await request(app).get('/');
    // Express redirect default is 302
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('GET /debug/env shows environment details', async () => {
    const res = await request(app).get('/debug/env');
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.nodeEnv).toBe(process.env.NODE_ENV);
    expect(body.appEnv).toBe(process.env.APP_ENV);
    expect(body.squareEnv).toBe(process.env.SQUARE_ENV);
    expect(body.hasSessionSecret).toBe(true);
    expect(body.hasGoogleClientId).toBe(true);
    expect(body.hasGoogleClientSecret).toBe(true);
    expect(body.googleCallbackUrl).toBe(process.env.GOOGLE_CALLBACK_URL);
    expect(Array.isArray(body.allowedEmails)).toBe(true);
    expect(body.allowedEmails).toEqual(['a@x.com', 'b@y.com']);
  });

  test('appContext middleware was used to set res.locals', async () => {
    // Hit a mocked route that runs middleware chain. We'll call one of the mocked route endpoints.
    const res = await request(app).get('/__mocked_route__auth');
    // Route returns JSON only if router was mounted and middleware chain ran.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, route: 'auth' });
    // While we cannot easily inspect res.locals from supertest, we ensure the appContext factory was invoked
    expect(mockAppContext).toHaveBeenCalled();
  });
});
