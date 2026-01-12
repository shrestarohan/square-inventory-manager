const request = require('supertest');
const express = require('express');
const buildSquareOAuthRouter = require('../../routes/squareOAuth');

describe('routes/squareOAuth', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
  });

  function makeApp({
    firestore = null,
    requireLogin = null,
    squareOAuthClient = null,
    createSquareClient = null,
    squareEnv = undefined,
  } = {}) {
    const router = buildSquareOAuthRouter({
      firestore,
      requireLogin,
      squareOAuthClient,
      createSquareClient,
      squareEnv,
    });
    const app = express();
    app.use(router);
    return app;
  }

  test('GET /connect-square - redirects to production Square auth URL when env set', async () => {
    process.env.SQUARE_APP_ID = 'test-app-id';
    process.env.SQUARE_APP_SECRET = 'secret';
    process.env.SQUARE_REDIRECT_URI = 'https://example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());

    const app = makeApp({ requireLogin, squareEnv: undefined });

    const res = await request(app).get('/connect-square');
    expect(res.status).toBe(302);
    const loc = res.header.location;
    expect(loc).toBeDefined();
    expect(loc).toContain('https://connect.squareup.com/oauth2/authorize');
    expect(loc).toContain(`client_id=${encodeURIComponent(process.env.SQUARE_APP_ID)}`);
    expect(loc).toContain(`redirect_uri=${encodeURIComponent(process.env.SQUARE_REDIRECT_URI)}`);
    // ensure scope and response_type present
    expect(loc).toContain('response_type=code');
    expect(loc).toContain('scope=');
    // ensure middleware was called
    expect(requireLogin).toHaveBeenCalled();
  });

  test('GET /connect-square - redirects to sandbox Square auth URL when squareEnv is sandbox', async () => {
    process.env.SQUARE_APP_ID = 'sandbox-app-id';
    process.env.SQUARE_REDIRECT_URI_DEV = 'https://dev.example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());

    const app = makeApp({ requireLogin, squareEnv: 'sandbox' });

    const res = await request(app).get('/connect-square');
    expect(res.status).toBe(302);
    const loc = res.header.location;
    expect(loc).toContain('https://connect.squareupsandbox.com/oauth2/authorize');
    expect(loc).toContain(`client_id=${encodeURIComponent(process.env.SQUARE_APP_ID)}`);
    expect(loc).toContain(`redirect_uri=${encodeURIComponent(process.env.SQUARE_REDIRECT_URI_DEV)}`);
  });

  test('GET /connect-square - returns 500 when SQUARE_APP_ID missing', async () => {
    delete process.env.SQUARE_APP_ID;
    delete process.env.SQUARE_REDIRECT_URI;

    const requireLogin = jest.fn((req, res, next) => next());
    const app = makeApp({ requireLogin });

    const res = await request(app).get('/connect-square');
    expect(res.status).toBe(500);
    expect(res.text).toBe('SQUARE_APP_ID is not configured');
  });

  test('GET /connect-square - returns 500 when REDIRECT_URI missing', async () => {
    process.env.SQUARE_APP_ID = 'id';
    delete process.env.SQUARE_REDIRECT_URI;
    delete process.env.SQUARE_REDIRECT_URI_PROD;
    delete process.env.SQUARE_REDIRECT_URI_DEV;

    const requireLogin = jest.fn((req, res, next) => next());
    const app = makeApp({ requireLogin });

    const res = await request(app).get('/connect-square');
    expect(res.status).toBe(500);
    expect(res.text).toBe('SQUARE_REDIRECT_URI is not configured');
  });

  test('GET /square/oauth/callback - returns 400 when Square returns error', async () => {
    process.env.SQUARE_APP_ID = 'id';
    process.env.SQUARE_APP_SECRET = 'secret';
    process.env.SQUARE_REDIRECT_URI = 'https://example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());
    const app = makeApp({ requireLogin });

    const res = await request(app).get('/square/oauth/callback').query({
      error: 'access_denied',
      error_description: 'user denied',
    });

    expect(res.status).toBe(400);
    expect(res.text).toContain('Square OAuth error: access_denied');
    expect(res.text).toContain('user denied');
  });

  test('GET /square/oauth/callback - returns 400 when missing code', async () => {
    process.env.SQUARE_APP_ID = 'id';
    process.env.SQUARE_APP_SECRET = 'secret';
    process.env.SQUARE_REDIRECT_URI = 'https://example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());
    const app = makeApp({ requireLogin });

    const res = await request(app).get('/square/oauth/callback');
    expect(res.status).toBe(400);
    expect(res.text).toBe('Missing authorization code');
  });

  test('GET /square/oauth/callback - returns 500 when SQUARE_APP_ID / SECRET not configured', async () => {
    // code present but missing secret
    process.env.SQUARE_APP_ID = 'id';
    delete process.env.SQUARE_APP_SECRET;
    process.env.SQUARE_REDIRECT_URI = 'https://example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());
    const app = makeApp({ requireLogin });

    const res = await request(app).get('/square/oauth/callback').query({ code: 'abc' });
    expect(res.status).toBe(500);
    expect(res.text).toBe('SQUARE_APP_ID / SQUARE_APP_SECRET not configured');
  });

  test('GET /square/oauth/callback - successful flow stores merchant and returns success message', async () => {
    process.env.SQUARE_APP_ID = 'app-id';
    process.env.SQUARE_APP_SECRET = 'app-secret';
    process.env.SQUARE_REDIRECT_URI = 'https://example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());

    // Mock firestore
    const setMock = jest.fn(() => Promise.resolve());
    const docMock = jest.fn(() => ({ set: setMock }));
    const collectionMock = jest.fn(() => ({ doc: docMock }));
    const firestore = { collection: collectionMock };

    // Mock OAuth client
    const squareOAuthClient = {
      oAuthApi: {
        obtainToken: jest.fn(() =>
          Promise.resolve({ result: { accessToken: 'acc-token', refreshToken: 'ref-token', merchantId: 'merchant-123' } })
        ),
      },
    };

    // Mock merchant client
    const merchantClient = {
      merchantsApi: {
        retrieveMerchant: jest.fn(() =>
          Promise.resolve({ result: { merchant: { businessName: 'My Business' } } })
        ),
      },
    };

    const createSquareClient = jest.fn(() => merchantClient);

    const app = makeApp({
      requireLogin,
      firestore,
      squareOAuthClient,
      createSquareClient,
      squareEnv: 'production',
    });

    const res = await request(app).get('/square/oauth/callback').query({ code: 'auth-code-123' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Square business connected successfully');
    expect(res.text).toContain('My Business');

    // Ensure we stored correct data
    expect(collectionMock).toHaveBeenCalledWith('merchants');
    expect(docMock).toHaveBeenCalledWith('merchant-123');
    expect(setMock).toHaveBeenCalledTimes(1);
    const setArg = setMock.mock.calls[0][0];
    expect(setArg).toMatchObject({
      merchant_id: 'merchant-123',
      business_name: 'My Business',
      access_token: 'acc-token',
      refresh_token: 'ref-token',
      env: 'production',
    });
    // connected_at should be an ISO string
    expect(typeof setArg.connected_at).toBe('string');
    expect(new Date(setArg.connected_at).toString()).not.toBe('Invalid Date');
  });

  test('GET /square/oauth/callback - handles OAuth client error and returns formatted details', async () => {
    process.env.SQUARE_APP_ID = 'app-id';
    process.env.SQUARE_APP_SECRET = 'secret';
    process.env.SQUARE_REDIRECT_URI = 'https://example.com/cb';

    const requireLogin = jest.fn((req, res, next) => next());

    const error = new Error('Upstream failure');
    // include an errors array to exercise the errors branch in catch
    error.errors = [{ detail: 'invalid code' }];

    const squareOAuthClient = {
      oAuthApi: {
        obtainToken: jest.fn(() => Promise.reject(error)),
      },
    };

    const app = makeApp({ requireLogin, squareOAuthClient, createSquareClient: jest.fn(), firestore: { collection: jest.fn() } });

    const res = await request(app).get('/square/oauth/callback').query({ code: 'bad-code' });
    expect(res.status).toBe(500);
    expect(res.text).toContain('<h2>OAuth error from Square</h2>');
    expect(res.text).toContain('Upstream failure');
    // Should include JSONified errors
    expect(res.text).toContain(JSON.stringify(error.errors, null, 2));
  });
});
