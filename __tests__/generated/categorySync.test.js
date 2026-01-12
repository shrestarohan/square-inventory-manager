const express = require('express');
const request = require('supertest');
const childProcess = require('child_process');
const path = require('path');

// Under test
const buildCategorySyncRouter = require('../../routes/categorySync');

// A controllable mock for spawn behavior per test
let lastSpawnCalls = [];
let nextSpawnBehavior = null; // { stdout?: string, stderr?: string, exitCode?: number }

beforeEach(() => {
  lastSpawnCalls = [];
  nextSpawnBehavior = null;

  jest.spyOn(childProcess, 'spawn').mockImplementation((execPath, args, opts) => {
    // create a child-like object
    const child = {};
    let stdoutCb = null;
    let stderrCb = null;
    let closeCb = null;

    child.stdout = {
      on: (ev, cb) => {
        if (ev === 'data') stdoutCb = cb;
      },
    };
    child.stderr = {
      on: (ev, cb) => {
        if (ev === 'data') stderrCb = cb;
      },
    };

    child.on = (ev, cb) => {
      if (ev === 'close') closeCb = cb;
    };

    // capture call info
    lastSpawnCalls.push({ execPath, args, opts, child });

    // schedule emission after listeners are attached (setImmediate runs after the current turn,
    // allowing the route handler to attach listeners synchronously)
    setImmediate(() => {
      const behavior = nextSpawnBehavior || {};
      if (behavior.stdout && stdoutCb) stdoutCb(Buffer.from(behavior.stdout));
      if (behavior.stderr && stderrCb) stderrCb(Buffer.from(behavior.stderr));
      const code = typeof behavior.exitCode === 'number' ? behavior.exitCode : 0;
      if (closeCb) closeCb(code);
    });

    return child;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function buildApp() {
  const app = express();
  app.use(express.json());
  // simple requireLogin middleware that allows all requests
  const router = buildCategorySyncRouter({ requireLogin: (req, res, next) => next() });
  app.use(router);
  return app;
}

describe('POST /api/categories/sync-from-square', () => {
  test('successful sync without merchantId -> returns success and null merchantId', async () => {
    // Arrange: behavior: small stdout, exit 0
    nextSpawnBehavior = { stdout: 'SYNC OK', stderr: '', exitCode: 0 };

    const app = buildApp();

    // Act
    const res = await request(app).post('/api/categories/sync-from-square').send({});

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, merchantId: null });
    expect(typeof res.body.output).toBe('string');
    expect(res.body.output).toContain('SYNC OK');

    // verify spawn was called and script filename is present in args
    expect(lastSpawnCalls.length).toBeGreaterThan(0);
    const { execPath, args } = lastSpawnCalls[0];
    expect(execPath).toBe(process.execPath);
    // first arg should be script path that ends with syncSquareCategoriesToFirestore.js
    expect(args[0]).toMatch(/syncSquareCategoriesToFirestore\.js$/);
    // --clean must be present (last element)
    expect(args).toContain('--clean');
  });

  test('successful sync with merchantId -> returns that merchantId', async () => {
    nextSpawnBehavior = { stdout: 'MERCHANT SYNCED', stderr: '', exitCode: 0 };

    const app = buildApp();

    const res = await request(app).post('/api/categories/sync-from-square').send({ merchantId: 'ML123' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, merchantId: 'ML123' });
    expect(res.body.output).toContain('MERCHANT SYNCED');

    // verify spawn args included --merchant ML123
    expect(lastSpawnCalls.length).toBeGreaterThan(0);
    const args = lastSpawnCalls[0].args;
    // find index of --merchant and check next value
    const idx = args.indexOf('--merchant');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('ML123');
    expect(args).toContain('--clean');
  });

  test('child process exits non-zero -> returns 500 with stderr/stdout and error message', async () => {
    nextSpawnBehavior = { stdout: 'partial output', stderr: 'something went wrong', exitCode: 2 };

    const app = buildApp();

    const res = await request(app).post('/api/categories/sync-from-square').send({ merchantId: 'MLX' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, merchantId: 'MLX' });
    expect(res.body.error).toMatch(/Sync failed with exit code 2/);
    expect(res.body.stderr).toContain('something went wrong');
    expect(res.body.stdout).toContain('partial output');
  });
});
