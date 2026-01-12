const jestLocal = jest;

// Prepare mocks BEFORE requiring the module under test
// Mock firestore
const mockFirestore = (() => {
  let merchantsSnapshot = [];
  const writes = [];
  const deletes = [];

  function collection(name) {
    return {
      doc: (id) => ({
        _path: `${name}/${id}`,
        collection: (sub) => ({
          doc: (subId) => ({ _path: `${name}/${id}/${sub}/${subId}` }),
        }),
      }),
      // Only merchants collection uses get() in our tests
      get: async () => {
        if (name === 'merchants') {
          return { size: merchantsSnapshot.length, docs: merchantsSnapshot };
        }
        return { size: 0, docs: [] };
      },
    };
  }

  function batch() {
    return {
      set: (ref, payload) => {
        writes.push({ ref, payload });
      },
      delete: (ref) => {
        deletes.push({ ref });
      },
      commit: async () => {
        // noop, commit just resolves
      },
    };
  }

  return {
    collection,
    batch,
    __internal: {
      writes,
      deletes,
      setMerchantsSnapshot: (arr) => {
        merchantsSnapshot = arr;
      },
      reset: () => {
        writes.length = 0;
        deletes.length = 0;
        merchantsSnapshot = [];
      },
    },
  };
})();

// Mock canonicalGtin
const mockGtin = {
  canonicalGtin: (v) => `CAN_${v}`,
};

// Fake Square client
const fakeClient = (() => {
  let catalogCalled = false;
  return {
    catalogApi: {
      // listCatalog(cursor, types)
      listCatalog: async (cursor, types) => {
        // One-shot page
        const objects = [
          // Item
          {
            id: 'item1',
            type: 'ITEM',
            itemData: {
              name: 'Test Item',
              categoryId: 'cat1',
              taxIds: ['tax1'],
              imageIds: ['img1'],
            },
          },
          // Variation
          {
            id: 'var1',
            type: 'ITEM_VARIATION',
            itemVariationData: {
              itemId: 'item1',
              sku: 'SKU1',
              upc: '12345',
              priceMoney: { amount: 499, currency: 'USD' },
              name: '12 oz',
            },
          },
          // Category
          {
            id: 'cat1',
            type: 'CATEGORY',
            categoryData: { name: 'Beverages' },
          },
          // Tax
          {
            id: 'tax1',
            type: 'TAX',
            taxData: { name: 'Sales Tax', percentage: '8.25' },
          },
          // Image
          {
            id: 'img1',
            type: 'IMAGE',
            imageData: { url: 'https://example.com/img.jpg' },
          },
        ];
        // return only once
        if (!catalogCalled) {
          catalogCalled = true;
          return { result: { objects, cursor: undefined } };
        }
        return { result: { objects: [], cursor: undefined } };
      },
    },

    locationsApi: {
      listLocations: async () => {
        return { result: { locations: [{ id: 'loc1', name: 'Main Location' }] } };
      },
    },

    inventoryApi: {
      // batchRetrieveInventoryCounts({ locationIds, cursor })
      batchRetrieveInventoryCounts: async ({ locationIds, cursor }) => {
        // Provide two counts: one normal, one to be ignored/deleted
        const counts = [
          {
            catalogObjectId: 'var1',
            quantity: '10',
            state: 'IN_STOCK',
            calculatedAt: '2020-01-01T00:00:00Z',
          },
          {
            catalogObjectId: 'var1',
            quantity: '1',
            state: 'RETURNED_BY_CUSTOMER',
            calculatedAt: '2020-01-01T00:00:00Z',
          },
        ];
        return { result: { counts, cursor: undefined } };
      },
    },
  };
})();

// Mock ../lib/square and ../lib/gtin and ../lib/firestore
jestLocal.mock('../lib/firestore', () => mockFirestore);
jestLocal.mock('../lib/square', () => ({
  createSquareClient: (_token, _env) => fakeClient,
}));
jestLocal.mock('../lib/gtin', () => mockGtin);

// Now require the module under test
const invSync = require('../lib/inventorySync');

describe('lib/inventorySync', () => {
  beforeAll(() => {
    // Freeze time to keep updated_at deterministic
    jestLocal.useFakeTimers('modern');
    jestLocal.setSystemTime(new Date('2020-01-01T00:00:00Z'));
  });

  afterAll(() => {
    jestLocal.useRealTimers();
  });

  beforeEach(() => {
    // reset internal mock firestore tracking
    mockFirestore.__internal.reset();
  });

  test('syncMerchantInventory writes inventory and deletes ignored states', async () => {
    const merchantDoc = {
      id: 'mer1',
      data: () => ({ business_name: 'Biz Name', access_token: 'tok', env: 'sandbox' }),
    };

    // Run sync for the merchant
    await invSync.syncMerchantInventory(merchantDoc);

    const writes = mockFirestore.__internal.writes;
    const deletes = mockFirestore.__internal.deletes;

    // Expect two deletes (master + merchant) for the RETURNED_BY_CUSTOMER
    expect(deletes.length).toBe(2);
    const deletePaths = deletes.map((d) => d.ref._path);
    expect(deletePaths).toEqual(expect.arrayContaining([
      'inventory/mer1_loc1_var1_RETURNED_BY_CUSTOMER',
      'merchants/mer1/inventory/mer1_loc1_var1_RETURNED_BY_CUSTOMER',
    ]));

    // Expect two writes (master + merchant) for the IN_STOCK item
    expect(writes.length).toBe(2);

    // Find the payload for IN_STOCK
    const inStockWrite = writes.find(w => w.ref._path.endsWith('mer1_loc1_var1_IN_STOCK'));
    expect(inStockWrite).toBeDefined();
    const payload = inStockWrite.payload;

    // Basic payload assertions
    expect(payload.merchant_id).toBe('mer1');
    expect(payload.merchant_name).toBe('Biz Name');
    expect(payload.merchant_name_lc).toBe('biz name');

    expect(payload.location_id).toBe('loc1');
    expect(payload.location_name).toBe('Main Location');
    expect(payload.location_name_lc).toBe('main location');

    expect(payload.catalog_object_id).toBe('var1');
    expect(payload.variation_id).toBe('var1');
    expect(payload.item_name).toBe('Test Item');

    // SKU and GTIN canonicalization
    expect(payload.sku).toBe('SKU1');
    expect(payload.sku_lc).toBe('sku1');
    expect(payload.gtin_raw).toBe('12345');
    expect(payload.gtin).toBe('CAN_12345');

    // Price conversion: 499 => 4.99
    expect(payload.price).toBeCloseTo(4.99);
    expect(payload.currency).toBe('USD');

    // search_tokens should include tokens for item, sku and ml/oz parsing
    expect(Array.isArray(payload.search_tokens)).toBe(true);
    expect(payload.search_tokens).toEqual(expect.arrayContaining(['test', 'item', 'sku1', '12', '12oz']));

    // qty and state
    expect(payload.qty).toBeCloseTo(10);
    expect(payload.state).toBe('IN_STOCK');

    // updated_at should reflect our frozen system time
    expect(typeof payload.updated_at).toBe('string');
    expect(payload.updated_at).toBe(new Date().toISOString());
  });

  test('syncAllMerchants iterates over merchants and calls syncMerchantInventory', async () => {
    // Prepare merchants snapshot with 2 merchants
    const docA = { id: 'a', data: () => ({ business_name: 'A', access_token: 't' }) };
    const docB = { id: 'b', data: () => ({ business_name: 'B', access_token: 't' }) };
    mockFirestore.__internal.setMerchantsSnapshot([docA, docB]);

    // Spy on syncMerchantInventory to avoid running full sync
    const spy = jestLocal.spyOn(invSync, 'syncMerchantInventory').mockImplementation(async () => {});

    await invSync.syncAllMerchants();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(docA);
    expect(spy).toHaveBeenCalledWith(docB);

    spy.mockRestore();
  });
});
