const express = require('express');
const request = require('supertest');
const buildReplenishmentRouter = require('../../routes/replenishment');

// Helper to build a fake firestore that records the limit value and returns provided docs
function makeFirestore(docs, onLimit) {
  const get = jest.fn().mockResolvedValue({ docs });
  const limitFn = jest.fn((n) => {
    if (onLimit) onLimit(n);
    return { get };
  });
  const collection2 = jest.fn(() => ({ limit: limitFn }));
  const doc = jest.fn(() => ({ collection: collection2 }));
  const collection1 = jest.fn(() => ({ doc }));

  return {
    collection: collection1,
    __mocks: { collection1, doc, collection2, limitFn, get },
  };
}

describe('routes/replenishment', () => {
  test('returns 400 if merchantId is missing', async () => {
    const firestore = makeFirestore([]);
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildReplenishmentRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/replenishment');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Missing merchantId' });
    expect(requireLogin).toHaveBeenCalled();
  });

  test('returns rows sorted by roq desc and uses default limit 200', async () => {
    const docs = [
      { id: 'a', data: () => ({ roq: 5, on_hand: 10, rop: 3 }) },
      { id: 'b', data: () => ({ roq: 20, on_hand: 2, rop: 10 }) },
      { id: 'c', data: () => ({ roq: 0, on_hand: 1, rop: 5 }) },
    ];
    let capturedLimit = null;
    const firestore = makeFirestore(docs, (n) => { capturedLimit = n; });
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildReplenishmentRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/replenishment').query({ merchantId: 'M123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.merchantId).toBe('M123');

    // rows should be sorted by roq desc: b (20), a (5), c (0)
    expect(res.body.rows.map(r => r.id)).toEqual(['b', 'a', 'c']);

    // default limit should be 200
    expect(capturedLimit).toBe(200);
    expect(requireLogin).toHaveBeenCalled();
  });

  test('onlyNeedsReorder filters items correctly for onlyNeedsReorder=1 and sorts by roq', async () => {
    const docs = [
      // should be kept because roq > 0
      { id: 'keep1', data: () => ({ roq: 10, on_hand: 50, rop: 20 }) },
      // should be kept because on_hand < rop
      { id: 'keep2', data: () => ({ roq: 0, on_hand: 2, rop: 5 }) },
      // should be filtered out
      { id: 'drop', data: () => ({ roq: 0, on_hand: 10, rop: 5 }) },
    ];
    let capturedLimit = null;
    const firestore = makeFirestore(docs, (n) => { capturedLimit = n; });
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildReplenishmentRouter({ firestore, requireLogin }));

    const res = await request(app)
      .get('/api/replenishment')
      .query({ merchantId: 'M456', onlyNeedsReorder: '1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // keep1 (roq 10) first, then keep2 (roq 0)
    expect(res.body.rows.map(r => r.id)).toEqual(['keep1', 'keep2']);
    // limit should still be default 200
    expect(capturedLimit).toBe(200);
  });

  test('respects limit param and caps to 1000', async () => {
    const docs = [
      { id: 'x', data: () => ({ roq: 1 }) }
    ];
    let capturedLimit = null;
    const firestore = makeFirestore(docs, (n) => { capturedLimit = n; });
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildReplenishmentRouter({ firestore, requireLogin }));

    // request limit larger than cap
    const res = await request(app)
      .get('/api/replenishment')
      .query({ merchantId: 'M789', limit: '5000' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // captured limit should be capped to 1000
    expect(capturedLimit).toBe(1000);
  });

  test('returns 500 when firestore.get throws', async () => {
    // build a firestore where get rejects
    const get = jest.fn().mockRejectedValue(new Error('boom'));
    const limitFn = jest.fn(() => ({ get }));
    const collection2 = jest.fn(() => ({ limit: limitFn }));
    const doc = jest.fn(() => ({ collection: collection2 }));
    const collection1 = jest.fn(() => ({ doc }));
    const firestore = { collection: collection1 };
    const requireLogin = jest.fn((req, res, next) => next());

    const app = express();
    app.use(buildReplenishmentRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/replenishment').query({ merchantId: 'ERR' });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('boom');
  });
});
