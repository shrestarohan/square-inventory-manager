const request = require('supertest');
const express = require('express');

// We'll mock the square factory used by the route. The module file (root/lib/square.js)
// is required by routes/categoriesRename. From this test file the path to that module
// is '../../lib/square'. We provide a jest mock factory that returns a makeCreateSquareClientForMerchant
// which, when invoked, will return whatever createSquareClientForMerchantMock references at runtime.

let createSquareClientForMerchantMock = jest.fn();

jest.mock('../../lib/square', () => ({
  makeCreateSquareClientForMerchant: ({ firestore }) => createSquareClientForMerchantMock,
}));

// Now require the router builder (after mocking the square factory)
const buildCategoriesRenameRouter = require('../../routes/categoriesRename');

describe('POST /api/categories/rename', () => {
  let firestore;
  let squareClient;
  let catalogApi;
  let setMock;
  let docMock;
  let addMock;
  let app;

  const merchantId = 'm-123';
  const categoryId = 'cat-789';
  const oldName = 'Old Category';
  const newName = 'New Category Name';

  beforeEach(() => {
    // reset and rebuild mocks per test
    jest.clearAllMocks();

    setMock = jest.fn(() => Promise.resolve());
    docMock = jest.fn(() => ({ set: setMock }));
    addMock = jest.fn(() => Promise.resolve());

    firestore = {
      collection: jest.fn((name) => {
        if (name === 'square_categories') return { doc: docMock };
        if (name === 'audit_logs') return { add: addMock };
        // Unexpected collection access should fail test loudly
        throw new Error(`Unexpected collection: ${name}`);
      }),
    };

    catalogApi = {
      retrieveCatalogObject: jest.fn(),
      upsertCatalogObject: jest.fn(),
    };

    squareClient = { catalogApi };

    // Default createSquareClientForMerchantMock will resolve to our squareClient
    createSquareClientForMerchantMock = jest.fn(() => Promise.resolve(squareClient));

    // Build an express app with the router
    app = express();
    app.use(express.json());

    // Simple requireLogin middleware used by the route to supply req.user
    const requireLogin = (req, res, next) => {
      req.user = { email: 'tester@example.com', id: 'user-1' };
      next();
    };

    app.use(buildCategoriesRenameRouter({ requireLogin, firestore }));
  });

  test('successfully renames a category: updates Square and Firestore and returns new info', async () => {
    // Simulate Square retrieve returning a CATEGORY object with a bigint version
    const catObj = {
      id: categoryId,
      type: 'CATEGORY',
      version: BigInt(42),
      categoryData: { name: oldName },
    };

    // Simulate Square upsert returning updated catalogObject with new version
    const updatedObj = {
      id: categoryId,
      type: 'CATEGORY',
      version: BigInt(43),
      categoryData: { name: newName },
    };

    catalogApi.retrieveCatalogObject.mockResolvedValue({ result: { object: catObj } });
    catalogApi.upsertCatalogObject.mockResolvedValue({ result: { catalogObject: updatedObj } });

    const resp = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, categoryId, newName })
      .expect(200);

    // Response shape
    expect(resp.body).toMatchObject({ success: true, merchantId, categoryId, categoryName: newName });
    // version should have been converted from bigint to string via jsonSafe
    expect(resp.body.version).toBe(String(updatedObj.version));

    // Ensure we asked Square for the object
    expect(catalogApi.retrieveCatalogObject).toHaveBeenCalledWith(categoryId, false);

    // Ensure we called upsert with expected object structure
    expect(catalogApi.upsertCatalogObject).toHaveBeenCalled();
    const upsertArg = catalogApi.upsertCatalogObject.mock.calls[0][0];
    expect(upsertArg).toBeDefined();
    // Basic checks of upsert body
    expect(upsertArg.object).toMatchObject({ id: categoryId, type: 'CATEGORY' });
    // version sent should be the jsonSafe version from retrieve (string of bigint)
    expect(String(upsertArg.object.version)).toEqual(String(catObj.version));
    expect(upsertArg.object.categoryData).toEqual({ name: newName });

    // Ensure Firestore doc was selected with the expected docId
    const expectedDocId = `${merchantId}__${categoryId}`;
    expect(docMock).toHaveBeenCalledWith(expectedDocId);

    // Ensure Firestore set called with merged data and expected fields
    expect(setMock).toHaveBeenCalled();
    const setArg = setMock.mock.calls[0][0];
    expect(setArg).toMatchObject({
      merchant_id: merchantId,
      category_id: categoryId,
      category_name: newName,
      version: String(updatedObj.version),
      last_action: 'rename',
    });
    // last_action_by should come from req.user.email
    expect(setArg.last_action_by).toBe('tester@example.com');

    // Ensure audit log was created
    expect(addMock).toHaveBeenCalled();
    const auditArg = addMock.mock.calls[0][0];
    expect(auditArg).toMatchObject({
      type: 'CATEGORY_RENAME',
      merchant_id: merchantId,
      category_id: categoryId,
      new_name: newName,
      old_name: oldName,
      actor: 'tester@example.com',
    });

    // Ensure the factory to create a square client was invoked with an object (firestore passed when building)
    // (The factory returns createSquareClientForMerchantMock which we set earlier; that function should have been called)
    expect(createSquareClientForMerchantMock).toHaveBeenCalled();
  });

  test('returns 400 when merchantId is missing', async () => {
    const resp = await request(app)
      .post('/api/categories/rename')
      .send({ categoryId, newName })
      .expect(400);

    expect(resp.body).toMatchObject({ success: false, error: 'Missing merchantId' });
    // Should not call Square
    expect(createSquareClientForMerchantMock).not.toHaveBeenCalled();
  });

  test('returns 400 when categoryId is missing', async () => {
    const resp = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, newName })
      .expect(400);

    expect(resp.body).toMatchObject({ success: false, error: 'Missing categoryId' });
    expect(createSquareClientForMerchantMock).not.toHaveBeenCalled();
  });

  test('returns 400 when newName is missing', async () => {
    const resp = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, categoryId })
      .expect(400);

    expect(resp.body).toMatchObject({ success: false, error: 'Missing newName' });
    expect(createSquareClientForMerchantMock).not.toHaveBeenCalled();
  });

  test('returns 404 when Square retrieve returns non-CATEGORY or missing object', async () => {
    // Missing object
    catalogApi.retrieveCatalogObject.mockResolvedValue({ result: { object: null } });

    const resp1 = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, categoryId, newName })
      .expect(404);

    expect(resp1.body).toMatchObject({ success: false });
    expect(String(resp1.body.error)).toContain('Square category not found');

    // Now return object that's not CATEGORY
    const nonCatObj = { id: categoryId, type: 'ITEM' };
    catalogApi.retrieveCatalogObject.mockResolvedValue({ result: { object: nonCatObj } });

    const resp2 = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, categoryId, newName })
      .expect(404);

    expect(resp2.body).toMatchObject({ success: false });
    expect(String(resp2.body.error)).toContain('Square category not found');
  });

  test('returns 500 when Square category missing version', async () => {
    const catWithoutVersion = { id: categoryId, type: 'CATEGORY', categoryData: { name: oldName } };
    catalogApi.retrieveCatalogObject.mockResolvedValue({ result: { object: catWithoutVersion } });

    const resp = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, categoryId, newName })
      .expect(500);

    expect(resp.body).toMatchObject({ success: false, error: 'Square category missing version (unexpected)' });
  });

  test('propagates unexpected exceptions as 500', async () => {
    // Force retrieve to throw
    catalogApi.retrieveCatalogObject.mockImplementation(() => { throw new Error('boom'); });

    const resp = await request(app)
      .post('/api/categories/rename')
      .send({ merchantId, categoryId, newName })
      .expect(500);

    expect(resp.body).toMatchObject({ success: false });
    expect(String(resp.body.error)).toContain('boom');
  });
});
