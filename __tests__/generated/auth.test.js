/* eslint-env jest */

const express = require('express');
const request = require('supertest');

// Ensure env vars used in building strategies are set (safe to set here)
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'GOOG_ID';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'GOOG_SECRET';
process.env.GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost/auth/google/callback';
process.env.ALLOWED_EMAILS = process.env.ALLOWED_EMAILS || '';

// Require the router builder
const buildAuthRouter = require('../../routes/auth');

// Helper to create a mock passport with controllable behavior
function createMockPassport() {
  const mock = {
    _localResponse: { err: null, user: null, info: null },
    _googleShouldFail: false,
    use: jest.fn(),
    serializeUser: jest.fn(),
    deserializeUser: jest.fn(),
    setLocalResponse(resp) {
      this._localResponse = resp;
    },
    setGoogleShouldFail(v) {
      this._googleShouldFail = !!v;
    },
    // emulate passport.authenticate(name, optionsOrCallback)
    authenticate(name, optionsOrCallback) {
      // If second arg is a callback -> custom callback usage (local)
      if (typeof optionsOrCallback === 'function') {
        const cb = optionsOrCallback;
        return (req, res, next) => {
          // Call the provided callback with the preconfigured local response
          cb(this._localResponse.err, this._localResponse.user, this._localResponse.info);
        };
      }

      const opts = optionsOrCallback || {};

      // Called to initiate Google auth (scope provided)
      if (opts.scope) {
        return (req, res, next) => {
          // Instead of redirecting to Google, return the options so tests can assert
          return res.json({ options: opts });
        };
      }

      // Called for Google callback: if configured to fail, redirect; otherwise attach user and call next
      if (opts.failureRedirect) {
        const failureRedirect = opts.failureRedirect;
        return (req, res, next) => {
          if (this._googleShouldFail) {
            return res.redirect(failureRedirect);
          }
          // success: attach a user and call next
          req.user = { id: 'google-user-1', email: 'user@example.com' };
          return next();
        };
      }

      // Default no-op
      return (req, res, next) => next();
    },
  };

  return mock;
}

// Minimal fake firestore (not used by our mocked passport flows)
const fakeFirestore = {
  collection() {
    return {
      doc() { return { get: async () => ({ exists: false }) }; },
      where() { return { limit() { return { get: async () => ({ empty: true, docs: [] }) }; } }; },
    };
  },
};

describe('routes/auth', () => {
  let passport;
  let app;

  beforeEach(() => {
    passport = createMockPassport();

    // Build a fresh express app for each test
    app = express();
    // Body parsing middleware for form posts
    app.use(express.urlencoded({ extended: false }));
  });

  test('GET /login redirects to /dashboard when authenticated', async () => {
    // middleware to mark request as authenticated
    app.use((req, res, next) => {
      req.isAuthenticated = () => true;
      next();
    });

    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    await request(app)
      .get('/login')
      .expect(302)
      .expect('Location', '/dashboard');
  });

  test('GET /login renders login view when not authenticated (exposes next and error)', async () => {
    // Provide a fake render implementation so res.render does not try to use a view engine
    app.use((req, res, next) => {
      req.isAuthenticated = () => false;
      res.render = (view, opts) => res.json({ view, opts });
      next();
    });

    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    const resp = await request(app)
      .get('/login')
      .query({ next: '/somewhere', error: 'oops' })
      .expect(200)
      .expect('Content-Type', /json/);

    expect(resp.body).toMatchObject({
      view: 'login',
      opts: { next: '/somewhere', error: 'oops' },
    });
  });

  test('POST /login success sets remember cookie maxAge and redirects to next', async () => {
    // Configure passport to return success for local
    const user = { id: 'u1', email: 'u1@example.com' };
    passport.setLocalResponse({ err: null, user, info: null });

    // Track session cookie modified during req.logIn
    let lastSessionCookie = null;

    app.use((req, res, next) => {
      // minimal session and logIn implementations
      req.session = { cookie: {} };
      req.logIn = (usr, cb) => {
        // simulate passport logIn storing user on req and expose cookie ref
        req.user = usr;
        lastSessionCookie = req.session.cookie;
        cb && cb();
      };
      next();
    });

    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    await request(app)
      .post('/login')
      .send('username=joe&password=pass&next=/private&remember=1')
      .expect(302)
      .expect('Location', '/private');

    // Verify cookie maxAge set to 14 days in ms
    expect(lastSessionCookie.maxAge).toBe(1000 * 60 * 60 * 24 * 14);
  });

  test('POST /login failure redirects back to /login with error and next', async () => {
    passport.setLocalResponse({ err: null, user: false, info: { message: 'Bad creds' } });

    // Provide a no-op req.logIn just in case
    app.use((req, res, next) => { req.logIn = (u, cb) => cb && cb(); next(); });

    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    const res = await request(app)
      .post('/login')
      .send('username=joe&password=wrong')
      .expect(302);

    // Should redirect to /login with encoded error and next
    expect(res.headers.location).toContain('/login?');
    expect(res.headers.location).toContain('error=Bad%20creds');
    expect(res.headers.location).toContain('next=%2Fdashboard');
  });

  test('GET /auth/google initiates google auth with correct options (state)', async () => {
    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    const res = await request(app)
      .get('/auth/google')
      .query({ next: '/after' })
      .expect(200)
      .expect('Content-Type', /json/);

    expect(res.body).toHaveProperty('options');
    const opts = res.body.options;
    expect(opts).toHaveProperty('scope');
    expect(opts.scope).toEqual(['profile', 'email']);
    expect(opts.prompt).toBe('select_account');
    // state should be encoded
    expect(opts.state).toBe(encodeURIComponent('/after'));
  });

  test('GET /auth/google/callback failure redirects to configured failureRedirect', async () => {
    // configure passport to fail google auth
    passport.setGoogleShouldFail(true);

    app.use((req, res, next) => { req.session = {}; next(); });
    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    const res = await request(app)
      .get('/auth/google/callback')
      .expect(302);

    // The router configured a specific failureRedirect message
    expect(res.headers.location).toContain('/login?error=');
  });

  test('GET /auth/google/callback success saves session and redirects to state', async () => {
    // configure passport to succeed
    passport.setGoogleShouldFail(false);

    // Provide a session with save() implemented so handler will call it
    let saveCalled = false;
    app.use((req, res, next) => {
      req.session = {
        save(cb) { saveCalled = true; cb && cb(); },
      };
      next();
    });

    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    const stateUrl = '/my-dashboard';
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ state: encodeURIComponent(stateUrl) })
      .expect(302);

    expect(saveCalled).toBe(true);
    expect(res.headers.location).toBe(stateUrl);
  });

  test('POST /logout calls logout and destroys session then redirects to /login', async () => {
    let logoutCalled = false;
    let destroyCalled = false;

    app.use((req, res, next) => {
      req.logout = (cb) => { logoutCalled = true; cb && cb(); };
      req.session = { destroy(cb) { destroyCalled = true; cb && cb(); } };
      next();
    });

    app.use(buildAuthRouter({ firestore: fakeFirestore, passport }));

    const res = await request(app)
      .post('/logout')
      .expect(302)
      .expect('Location', '/login');

    expect(logoutCalled).toBe(true);
    expect(destroyCalled).toBe(true);
  });
});
