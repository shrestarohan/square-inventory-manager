/* eslint-env jest */

describe('lib/squareCatalog', () => {
  afterEach(() => {
    // Clean up between tests so module is re-evaluated with fresh mocks/env
    jest.resetModules();
    delete process.env.SQUARE_ENV;
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  test('fetchAllCatalogVariations paginates, filters ITEM_VARIATION and passes cursors', async () => {
    // Arrange: set env before requiring the module so the client is constructed correctly
    process.env.SQUARE_ENV = 'notproduction';
    process.env.SQUARE_ACCESS_TOKEN = 'token123';

    const listCatalogMock = jest.fn()
      .mockResolvedValueOnce({
        result: {
          objects: [
            { type: 'ITEM', id: 'i1' },
            { type: 'ITEM_VARIATION', id: 'v1', itemVariationData: { upc: '123', name: 'var1' } },
            { type: 'ITEM_VARIATION', id: 'v2', itemVariationData: null },
          ],
          cursor: 'CURSOR_1',
        },
      })
      .mockResolvedValueOnce({
        result: {
          objects: [
            { type: 'ITEM_VARIATION', id: 'v3', itemVariationData: { upc: '456', name: 'var3' } },
          ],
          cursor: undefined,
        },
      });

    const mockClient = { catalogApi: { listCatalog: listCatalogMock } };
    const ClientMock = jest.fn(() => mockClient);
    const EnvironmentMock = { Production: 'PROD', Sandbox: 'SBX' };

    // Provide the mocked 'square/legacy' before requiring the module
    jest.doMock('square/legacy', () => ({ Client: ClientMock, Environment: EnvironmentMock }));

    const mod = require('../../lib/squareCatalog');

    // Client should have been constructed with Sandbox environment and provided token
    expect(ClientMock).toHaveBeenCalledTimes(1);
    expect(ClientMock).toHaveBeenCalledWith(expect.objectContaining({ environment: 'SBX', accessToken: 'token123' }));

    // Act
    const variations = await mod.fetchAllCatalogVariations();

    // Assert: should only include ITEM_VARIATION entries that have itemVariationData
    expect(Array.isArray(variations)).toBe(true);
    expect(variations).toHaveLength(2);

    // Check returned UPCs in order collected (first page then second page)
    const upcs = variations.map((v) => v.itemVariationData && v.itemVariationData.upc);
    expect(upcs).toEqual(['123', '456']);

    // Ensure listCatalog was called with expected args and cursor progression
    expect(listCatalogMock).toHaveBeenCalledTimes(2);
    expect(listCatalogMock).toHaveBeenNthCalledWith(1, undefined, 'ITEM,ITEM_VARIATION');
    expect(listCatalogMock).toHaveBeenNthCalledWith(2, 'CURSOR_1', 'ITEM,ITEM_VARIATION');
  });

  test('buildGtinToVariationMap creates map of upc -> variation, skips missing upc, last one wins', async () => {
    // Arrange: fresh module import with a client mock (not used since we'll spy on fetchAllCatalogVariations)
    process.env.SQUARE_ENV = 'sandbox';
    const ClientMock = jest.fn(() => ({ catalogApi: { listCatalog: jest.fn() } }));
    jest.doMock('square/legacy', () => ({ Client: ClientMock, Environment: { Production: 'P', Sandbox: 'S' } }));

    const mod = require('../../lib/squareCatalog');

    // Prepare variations: two with same GTIN '111' and one without upc
    const varA = { id: 'a', itemVariationData: { upc: '111', name: 'A' } };
    const varB = { id: 'b', itemVariationData: { upc: null, name: 'B' } };
    const varC = { id: 'c', itemVariationData: { upc: '111', name: 'C' } };

    // Spy/Mock the fetchAllCatalogVariations function to return our prepared list
    jest.spyOn(mod, 'fetchAllCatalogVariations').mockResolvedValue([varA, varB, varC]);

    // Act
    const map = await mod.buildGtinToVariationMap();

    // Assert
    expect(map).toBeInstanceOf(Map);
    // Only '111' should be present and value should be the last one (varC)
    expect(map.size).toBe(1);
    expect(map.get('111')).toBe(varC);
  });

  test('constructs client with Production environment when SQUARE_ENV=production', () => {
    // Arrange: set production env and mock Client to capture constructor args
    process.env.SQUARE_ENV = 'production';
    process.env.SQUARE_ACCESS_TOKEN = 'prodtoken';

    const ClientMock = jest.fn(() => ({ catalogApi: { listCatalog: jest.fn() } }));
    const EnvironmentMock = { Production: 'ENV_PROD', Sandbox: 'ENV_SBX' };

    jest.doMock('square/legacy', () => ({ Client: ClientMock, Environment: EnvironmentMock }));

    // Act: require module which will construct the client
    const mod = require('../../lib/squareCatalog');

    // Assert: verify constructor called with Production environment and the token
    expect(ClientMock).toHaveBeenCalledTimes(1);
    expect(ClientMock).toHaveBeenCalledWith(expect.objectContaining({ environment: 'ENV_PROD', accessToken: 'prodtoken' }));

    // Also exported squareClient should be the object returned by our ClientMock
    expect(mod.squareClient).toBeDefined();
    expect(mod.squareClient.catalogApi).toBeDefined();
  });
});
