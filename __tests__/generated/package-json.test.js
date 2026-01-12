process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const pkg = require('../../package.json');

describe('package.json basic validation', () => {
  test('package.json loads and has basic fields', () => {
    expect(pkg).toBeDefined();
    expect(typeof pkg).toBe('object');
    expect(pkg.name).toBe('square-inventory-sync');
    expect(pkg.version).toBeDefined();
    expect(pkg.main).toBe('server.js');
  });

  test('scripts include expected commands and test uses --runInBand', () => {
    expect(pkg.scripts).toBeDefined();
    // essential scripts
    expect(pkg.scripts.start).toBe('node server.js');
    expect(pkg.scripts.dev).toMatch(/nodemon/);

    // Ensure test scripts run Jest with --runInBand for CI-friendly single-threaded runs
    expect(pkg.scripts.test).toMatch(/jest.*--runInBand/);
    expect(pkg.scripts['test:ci']).toMatch(/--runInBand/);

    // Spot check other named scripts referenced in repo
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining([
      'sync:inventory',
      'sync:gtin-meta',
      'gen:tests'
    ]));
  });

  test('dependencies contain important runtime libs', () => {
    expect(pkg.dependencies).toBeDefined();
    const deps = pkg.dependencies;

    // runtime dependencies that the app likely needs
    ['express', 'openai', 'square', '@google-cloud/firestore', 'dotenv', 'axios'].forEach(dep => {
      expect(deps).toHaveProperty(dep);
      // basic sanity: version is a non-empty string
      expect(typeof deps[dep]).toBe('string');
      expect(deps[dep].length).toBeGreaterThan(0);
    });
  });

  test('devDependencies include test tooling', () => {
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies).toHaveProperty('jest');
    expect(pkg.devDependencies).toHaveProperty('supertest');

    // ensure jest version string looks reasonable
    expect(typeof pkg.devDependencies.jest).toBe('string');
    expect(pkg.devDependencies.jest.length).toBeGreaterThan(0);
  });

  test('scripts do not make network calls during test startup (sanity)', () => {
    // This is a lightweight check: ensure no script accidentally contains `curl`, `wget`, or `npm run start` with http
    const scriptsConcatenated = Object.values(pkg.scripts).join(' ');
    expect(scriptsConcatenated).not.toMatch(/\bcurl\b|\bwget\b|https?:\/\//);
  });
});
