const request = require('supertest');
const express = require('express');
const buildReplenishmentAiPageRouter = require('../../routes/replenishmentAiPage');

describe('replenishmentAiPage router', () => {
  let app;

  beforeEach(() => {
    app = express();
    // Intercept res.render so routes that call res.render return JSON we can assert on
    app.use((req, res, next) => {
      res.render = (view, data) => res.json({ view, data });
      next();
    });
  });

  test('renders replenishment-ai with merchants and no merchantId when not provided', async () => {
    const merchantsDocs = [
      { id: 'm1', data: () => ({ name: 'Merchant One' }) },
      { id: 'm2', data: () => ({ name: 'Merchant Two' }) },
    ];

    const getMock = jest.fn().mockResolvedValue({ docs: merchantsDocs });
    const collectionMock = jest.fn().mockReturnValue({ get: getMock });

    const firestore = { collection: collectionMock };
    const requireLogin = jest.fn((req, res, next) => next());

    app.use('/', buildReplenishmentAiPageRouter({ firestore, requireLogin }));

    const res = await request(app).get('/replenishment-ai');

    expect(res.status).toBe(200);
    expect(res.body.view).toBe('replenishment-ai');
    expect(res.body.data).toBeDefined();
    expect(res.body.data.merchantId).toBeNull();
    expect(Array.isArray(res.body.data.merchants)).toBe(true);
    expect(res.body.data.merchants).toEqual([
      { id: 'm1', name: 'Merchant One' },
      { id: 'm2', name: 'Merchant Two' },
    ]);

    // ensure firestore was used for merchants
    expect(collectionMock).toHaveBeenCalledWith('merchants');
    expect(getMock).toHaveBeenCalled();
    // requireLogin should have been called
    expect(requireLogin).toHaveBeenCalled();
  });

  test('renders replenishment-ai with provided merchantId param', async () => {
    const merchantsDocs = [{ id: 'm1', data: () => ({ name: 'Only' }) }];
    const firestore = { collection: () => ({ get: jest.fn().mockResolvedValue({ docs: merchantsDocs }) }) };
    const requireLogin = jest.fn((req, res, next) => next());

    app.use('/', buildReplenishmentAiPageRouter({ firestore, requireLogin }));

    const res = await request(app).get('/replenishment-ai/m1');

    expect(res.status).toBe(200);
    expect(res.body.view).toBe('replenishment-ai');
    expect(res.body.data.merchantId).toBe('m1');
    expect(res.body.data.merchants).toEqual([{ id: 'm1', name: 'Only' }]);
    expect(requireLogin).toHaveBeenCalled();
  });

  test('returns 500 and message when firestore throws', async () => {
    // make collection throw
    const firestore = { collection: () => { throw new Error('boom'); } };
    const requireLogin = jest.fn((req, res, next) => next());

    // silence console.error output during test and capture it
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    app.use('/', buildReplenishmentAiPageRouter({ firestore, requireLogin }));

    const res = await request(app).get('/replenishment-ai');

    expect(res.status).toBe(500);
    expect(res.text).toBe('Failed to render replenishment AI page.');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
