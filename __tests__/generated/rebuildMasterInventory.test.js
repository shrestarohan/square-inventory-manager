const path = require('path');

// Tests for scripts/rebuildMasterInventory.js
// The script invokes rebuildMasterInventory() at module load, so each test must
// set up mocks and environment BEFORE requiring the script. We use absolute
// paths to ensure jest.doMock targets the same module instance the script will
// require.

describe('rebuildMasterInventory script', () => {
  const scriptPath = path.resolve(__dirname, '../../scripts/rebuildMasterInventory.js');
  const firestoreResolvedPath = path.resolve(path.dirname(scriptPath), '../lib/firestore.js');
  let originalEnv;
  let origConsoleLog;

  beforeAll(() => {
    originalEnv = { ...process.env };
    origConsoleLog = console.log;
  });

  afterAll(() => {
    process.env = originalEnv;
    console.log = origConsoleLog;
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('exits early when no merchants found (DRY_RUN default true)', async () => {
    // Ensure DRY_RUN default (unset -> true)
    delete process.env.DRY_RUN;

    // Prepare a mock firestore that returns an empty merchants snapshot
    const merchantsSnap = { empty: true, docs: [] };

    const firestoreMock = {
      collection: jest.fn((name) => {
        if (name === 'merchants') {
          return { get: jest.fn().mockResolvedValue(merchantsSnap) };
        }
        // any other collection should not be used in this test
        return { get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) };
      }),
      batch: jest.fn(() => ({ set: jest.fn(), commit: jest.fn().mockResolvedValue() })),
    };

    // Spy on console.log and resolve when the script finishes
    let doneResolve;
    const donePromise = new Promise((resolve) => {
      doneResolve = resolve;
    });

    console.log = jest.fn((...args) => {
      // When the script logs that no merchants found, treat as done
      try {
        const joined = args.join(' ');
        if (joined.includes('No merchants found, exiting.')) {
          doneResolve();
        }
      } catch (e) {
        // ignore
      }
    });

    // Mock the firestore module at the exact resolved path the script will require
    jest.doMock(firestoreResolvedPath, () => firestoreMock);

    // Require the script in isolated module registry so mocks apply cleanly
    jest.isolateModules(() => {
      require(scriptPath);
    });

    // Wait until the script logs completion
    await donePromise;

    // Assertions
    expect(firestoreMock.collection).toHaveBeenCalledWith('merchants');
    // Because DRY_RUN and no merchants, batch should never be created/called
    expect(firestoreMock.batch).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  test('writes master docs when DRY_RUN=false (calls batch.set and commit)', async () => {
    // Force non-dry run
    process.env.DRY_RUN = 'false';

    // Build a merchant with a single inventory page of 3 docs, then an empty page
    const docData = (id) => ({ sku: `sku-${id}`, name: `Item ${id}` });

    const page1Docs = [
      { id: 'd1', data: () => docData('d1') },
      { id: 'd2', data: () => docData('d2') },
      { id: 'd3', data: () => docData('d3') },
    ];

    const page1Snap = { empty: false, size: page1Docs.length, docs: page1Docs };
    const emptySnap = { empty: true, size: 0, docs: [] };

    // Query factory that will return page1 then empty
    let queryGetCallCount = 0;
    const queryFactory = () => {
      const q = {
        startAfter: () => q,
        get: jest.fn().mockImplementation(() => {
          // return page1 on first call, empty on second
          const res = queryGetCallCount === 0 ? page1Snap : emptySnap;
          queryGetCallCount += 1;
          return Promise.resolve(res);
        }),
      };
      return q;
    };

    // merchant.ref.collection('inventory') should return an object with orderBy
    const invCollection = {
      orderBy: jest.fn().mockImplementation(() => ({ limit: jest.fn().mockImplementation(() => queryFactory()) })),
    };

    const merchantRef = {
      collection: jest.fn((name) => {
        if (name === 'inventory') return invCollection;
        return { orderBy: () => ({ limit: () => ({ get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }) }) };
      }),
    };

    const merchantsSnap = { empty: false, docs: [ { id: 'm1', ref: merchantRef } ] };

    // Track batch operations
    const mockSet = jest.fn();
    const mockCommit = jest.fn().mockResolvedValue();
    const batchFactory = jest.fn(() => ({ set: mockSet, commit: mockCommit }));

    const firestoreMock = {
      collection: jest.fn((name) => {
        if (name === 'merchants') {
          return { get: jest.fn().mockResolvedValue(merchantsSnap) };
        }
        if (name === 'inventory') {
          // master inventory collection reference used for masterRef.doc(...)
          return { doc: jest.fn((id) => ({ id })) };
        }
        // fallback
        return { get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) };
      }),
      batch: batchFactory,
    };

    // Capture logs and resolve when final Done log appears
    let doneResolve;
    const donePromise = new Promise((resolve) => {
      doneResolve = resolve;
    });

    console.log = jest.fn((...args) => {
      try {
        const joined = args.join(' ');
        if (joined.includes("Done. Saw") || joined.includes("would write") || joined.includes("wrote")) {
          doneResolve();
        }
      } catch (e) {}
    });

    // Mock firestore module
    jest.doMock(firestoreResolvedPath, () => firestoreMock);

    // Require the script (it will start execution immediately)
    jest.isolateModules(() => {
      require(scriptPath);
    });

    // Wait for script to finish
    await donePromise;

    // Assertions
    // Ensure we read merchants
    expect(firestoreMock.collection).toHaveBeenCalledWith('merchants');

    // batch should have been created at least once
    expect(batchFactory).toHaveBeenCalled();

    // set should have been called once per doc (3)
    expect(mockSet).toHaveBeenCalledTimes(3);

    // commit should be called once at end of page since total docs (3) < BATCH_LIMIT
    expect(mockCommit).toHaveBeenCalledTimes(1);

    // Verify that inventory collection on merchant was used
    expect(merchantRef.collection).toHaveBeenCalledWith('inventory');
  });
});
