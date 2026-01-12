/* eslint-env jest */
const path = require('path');

describe('lib/loadEnv', () => {
  const MODULE_PATH = path.resolve(__dirname, '../../lib/loadEnv');
  let originalEnv;

  beforeEach(() => {
    // snapshot environment and reset modules so each test can require afresh
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    // restore environment and any mocked globals
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  test('loads in local mode, reads ENV_FILE and exports flags; prints masked summary', () => {
    // prepare env: local (no K_SERVICE), custom ENV_FILE, and all required vars
    process.env = {
      ...originalEnv,
      K_SERVICE: undefined,
      ENV_FILE: 'test.env',
      APP_ENV: 'dev',
      FIRESTORE_DATABASE_ID: 'db1',
      GOOGLE_CLOUD_PROJECT: 'proj-x',
      CRON_SECRET: 'cron-y',
      OPENAI_API_KEY: 'sk_test_openai_abcdef',
      SQUARE_ACCESS_TOKEN: 'sq_test_token_12345',
      SQUARE_ENV: 'sandbox',
    };

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // require module after spies/env are set
    const mod = require(MODULE_PATH);

    expect(mod.isCloudRun).toBe(false);
    expect(mod.envName).toBe('test.env');
    expect(mod.APP_ENV).toBe('dev');
    expect(typeof mod.requireEnv).toBe('function');

    // console.log should include the Loaded env file message and ENV CHECK OK
    const logged = logSpy.mock.calls.flat();
    const joined = logged.join('\n');
    expect(joined).toMatch(/Loaded env file:\s*test.env/);
    expect(joined).toMatch(/ENV CHECK OK \(local\)/);

    logSpy.mockRestore();
  });

  test('detects Cloud Run and skips dotenv; ENV check reports cloud-run', () => {
    process.env = {
      ...originalEnv,
      K_SERVICE: 'my-service', // triggers cloud-run path
      // ensure required vars are present
      APP_ENV: 'dev',
      FIRESTORE_DATABASE_ID: 'db1',
      GOOGLE_CLOUD_PROJECT: 'proj-x',
      CRON_SECRET: 'cron-y',
      OPENAI_API_KEY: 'sk_test_openai_abcdef',
      SQUARE_ACCESS_TOKEN: 'sq_test_token_12345',
      SQUARE_ENV: 'sandbox',
    };

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const mod = require(MODULE_PATH);

    expect(mod.isCloudRun).toBe(true);
    // envName should still reflect default since ENV_FILE not set
    expect(mod.envName).toBe('secrets/.env');
    expect(mod.APP_ENV).toBe('dev');

    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/Cloud Run detected; skipping dotenv/);
    expect(logged).toMatch(/ENV CHECK OK \(cloud-run\)/);

    logSpy.mockRestore();
  });

  test('missing required env triggers process.exit with helpful error', () => {
    // local mode, but intentionally omit OPENAI_API_KEY to trigger failure
    process.env = {
      ...originalEnv,
      K_SERVICE: undefined,
      APP_ENV: 'dev',
      FIRESTORE_DATABASE_ID: 'db1',
      GOOGLE_CLOUD_PROJECT: 'proj-x',
      CRON_SECRET: 'cron-y',
      // OPENAI_API_KEY: missing on purpose
      SQUARE_ACCESS_TOKEN: 'sq_test_token_12345',
      SQUARE_ENV: 'sandbox',
    };

    // Intercept process.exit so the test runner doesn't exit; throw to allow assertion
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((code) => {
        throw new Error(`process.exit:${code}`);
      });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Requiring the module should cause requireEnv to detect missing var and call process.exit
    expect(() => {
      require(MODULE_PATH);
    }).toThrow(/process.exit:1/);

    // console.error should have been called with an explanatory message
    const errLogged = errSpy.mock.calls.flat().join('\n');
    expect(errLogged).toMatch(/ENV CHECK FAILED/);
    expect(errLogged).toMatch(/Missing:/);
    expect(errLogged).toMatch(/OPENAI_API_KEY/);

    // restore
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
