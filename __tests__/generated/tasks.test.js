const request = require('supertest');
const express = require('express');

const buildTasksRouter = require('../../routes/tasks');

describe('routes/tasks', () => {
  let app;
  let syncAllMerchants;
  let runBuildGtinMatrix;
  let collectionMock;
  let docMock;
  let setMock;
  let originalDateNow;

  beforeAll(() => {
    // make Date.now deterministic for run id and ISO timestamp generation
    originalDateNow = Date.now;
    jest.spyOn(Date, 'now').mockReturnValue(1600000000000); // fixed timestamp
  });

  afterAll(() => {
    // restore Date.now
    if (Date.now && Date.now.mockRestore) Date.now.mockRestore();
    else Date.now = originalDateNow;
  });

  beforeEach(() => {
    syncAllMerchants = jest.fn().mockResolvedValue(undefined);
    runBuildGtinMatrix = jest.fn().mockResolvedValue(undefined);

    setMock = jest.fn().mockResolvedValue(undefined);
    docMock = jest.fn().mockReturnValue({ set: setMock });
    collectionMock = jest.fn().mockReturnValue({ doc: docMock });

    const firestore = { collection: collectionMock };

    app = express();
    app.use(buildTasksRouter({ firestore, syncAllMerchants, runBuildGtinMatrix }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('POST /tasks/sync-inventory - success', async () => {
    const res = await request(app).post('/tasks/sync-inventory').send();

    expect(res.status).toBe(200);
    expect(res.text).toBe('Inventory sync completed');
    expect(syncAllMerchants).toHaveBeenCalledTimes(1);
  });

  test('POST /tasks/sync-inventory - failure returns 500 and error message', async () => {
    syncAllMerchants.mockRejectedValueOnce(new Error('boom-sync'));

    const res = await request(app).post('/tasks/sync-inventory').send();

    expect(res.status).toBe(500);
    expect(res.text).toBe('Inventory sync failed: boom-sync');
    expect(syncAllMerchants).toHaveBeenCalledTimes(1);
  });

  test('GET /tasks/full-nightly-sync - success calls both tasks and writes firestore', async () => {
    const res = await request(app).get('/tasks/full-nightly-sync');

    expect(res.status).toBe(200);
    expect(res.text).toBe('✅ Nightly sync + GTIN matrix rebuild completed');

    expect(syncAllMerchants).toHaveBeenCalledTimes(1);
    expect(runBuildGtinMatrix).toHaveBeenCalledTimes(1);

    // firestore.collection('meta').doc('sync_status').set({...}, { merge: true })
    expect(collectionMock).toHaveBeenCalledTimes(1);
    expect(collectionMock).toHaveBeenCalledWith('meta');
    expect(docMock).toHaveBeenCalledTimes(1);
    expect(docMock).toHaveBeenCalledWith('sync_status');
    expect(setMock).toHaveBeenCalledTimes(1);

    const setArgs = setMock.mock.calls[0];
    expect(setArgs.length).toBeGreaterThanOrEqual(1);

    const writtenObj = setArgs[0];
    const options = setArgs[1];

    expect(writtenObj).toHaveProperty('last_full_sync_at');
    expect(writtenObj).toHaveProperty('last_full_sync_run_id');

    // With Date.now mocked to 1600000000000
    expect(writtenObj.last_full_sync_run_id).toBe('full-1600000000000');
    expect(writtenObj.last_full_sync_at).toBe(new Date(1600000000000).toISOString());

    expect(options).toEqual({ merge: true });
  });

  test('GET /tasks/full-nightly-sync - failure in syncAllMerchants returns 500', async () => {
    // rebuild app with a failing syncAllMerchants
    syncAllMerchants.mockRejectedValueOnce(new Error('sync-boom'));

    const res = await request(app).get('/tasks/full-nightly-sync');

    expect(res.status).toBe(500);
    expect(res.text).toBe('Nightly job failed: sync-boom');

    expect(syncAllMerchants).toHaveBeenCalledTimes(1);
    // runBuildGtinMatrix should not be called due to early failure
    expect(runBuildGtinMatrix).not.toHaveBeenCalled();
    // firestore should not be written to
    expect(setMock).not.toHaveBeenCalled();
  });

  test('GET /tasks/full-nightly-sync - failure in runBuildGtinMatrix returns 500', async () => {
    runBuildGtinMatrix.mockRejectedValueOnce(new Error('build-boom'));

    const res = await request(app).get('/tasks/full-nightly-sync');

    expect(res.status).toBe(500);
    expect(res.text).toBe('Nightly job failed: build-boom');

    expect(syncAllMerchants).toHaveBeenCalledTimes(1);
    expect(runBuildGtinMatrix).toHaveBeenCalledTimes(1);
    expect(setMock).not.toHaveBeenCalled();
  });

  test('GET /tasks/full-nightly-sync - firestore.set throws returns 500 with message', async () => {
    setMock.mockRejectedValueOnce(new Error('firestore-boom'));

    const res = await request(app).get('/tasks/full-nightly-sync');

    expect(res.status).toBe(500);
    // Router uses (err.message || String(err)) so expect the message
    expect(res.text).toBe('Nightly job failed: firestore-boom');

    expect(syncAllMerchants).toHaveBeenCalledTimes(1);
    expect(runBuildGtinMatrix).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});
