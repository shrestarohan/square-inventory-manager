const request = require('supertest');
const express = require('express');

const buildCategoriesListRouter = require('../../routes/categoriesList');

function makeFirestore({ docs = [], throwError = null } = {}) {
  const getMock = jest.fn();
  if (throwError) {
    getMock.mockImplementation(async () => { throw new Error(throwError); });
  } else {
    getMock.mockResolvedValue({ docs });
  }

  const whereSpy = jest.fn((field, op, val) => ({ get: getMock }));
  const collectionSpy = jest.fn((name) => ({ where: whereSpy }));

  return {
    firestore: { collection: collectionSpy },
    spies: { collectionSpy, whereSpy, getMock }
  };
}

describe('routes/categoriesList', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns 400 if merchantId is missing and does not call firestore', async () => {
    const { firestore, spies } = makeFirestore({});
    let requireLoginCalled = false;
    const requireLogin = (req, res, next) => { requireLoginCalled = true; return next(); };

    const app = express();
    app.use(buildCategoriesListRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Missing merchantId' });
    expect(requireLoginCalled).toBe(true);
    expect(spies.collectionSpy).not.toHaveBeenCalled();
  });

  test('returns sorted, filtered categories for a merchantId', async () => {
    const docs = [
      { data: () => ({ category_id: 'c1', category_name: 'Banana' }) },
      { data: () => ({ category_id: 'c2', category_name: 'Apple' }) },
      { data: () => ({ category_id: '', category_name: 'NoId' }) },
      { data: () => ({}) },
      { data: () => null }
    ];

    const { firestore, spies } = makeFirestore({ docs });

    const requireLogin = (req, res, next) => next();

    const app = express();
    app.use(buildCategoriesListRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/categories').query({ merchantId: 'm123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.categories).toEqual([
      { categoryId: 'c2', name: 'Apple' },
      { categoryId: 'c1', name: 'Banana' }
    ]);

    // Assert Firestore was queried correctly
    expect(spies.collectionSpy).toHaveBeenCalledWith('square_categories');
    expect(spies.whereSpy).toHaveBeenCalledWith('merchant_id', '==', 'm123');
    expect(spies.getMock).toHaveBeenCalled();
  });

  test('returns 500 and logs error when firestore.get throws', async () => {
    const { firestore, spies } = makeFirestore({ throwError: 'boom' });
    const requireLogin = (req, res, next) => next();

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const app = express();
    app.use(buildCategoriesListRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/categories').query({ merchantId: 'm123' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('boom');
    expect(consoleSpy).toHaveBeenCalled();

    // Firestore was called
    expect(spies.collectionSpy).toHaveBeenCalledWith('square_categories');
  });

  test('if requireLogin short-circuits (e.g., returns 401) firestore is not called', async () => {
    const { firestore, spies } = makeFirestore({});
    const requireLogin = (req, res, next) => res.status(401).json({ success: false, error: 'Not logged in' });

    const app = express();
    app.use(buildCategoriesListRouter({ firestore, requireLogin }));

    const res = await request(app).get('/api/categories').query({ merchantId: 'm123' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Not logged in' });
    expect(spies.collectionSpy).not.toHaveBeenCalled();
  });
});
