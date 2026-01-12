// Jest tests for routes/itemsSetCategoryId.js

const express = require("express");
const request = require("supertest");

// Mock the square factory module used by the router. The router requires ../lib/square
// (relative to routes file). From this test file we will mock the resolved module
// path as '../../lib/square' because we import the router from '../../routes/...'.

jest.mock("../../lib/square", () => {
  // createFn will be set per-test to return a function that, when called,
  // will produce the square client for a merchant.
  let createFn = () => async () => ({ catalogApi: {} });

  return {
    __esModule: true,
    makeCreateSquareClientForMerchant: jest.fn((opts) => {
      // Return a function createSquareClientForMerchant that delegates to createFn
      return (...args) => createFn(opts)(...args);
    }),
    // helper to set the factory from tests
    __setCreateSquareClientFactory: (fn) => {
      createFn = fn;
    },
  };
});

const squareModuleMock = require("../../lib/square");

// Now require the router under test after we've mocked the square module.
const buildItemsSetCategoryIdRouter = require("../../routes/itemsSetCategoryId");

// Simple requireLogin middleware for tests
function requireLogin(req, res, next) {
  req.user = { email: "tester@example.com", id: "user-test" };
  next();
}

// Helper to build a minimal Firestore mock. Tests supply a getHandler function
// which receives (collectionName, queriesArray) and should return a promise
// resolving to a snapshot: { empty: boolean, docs: [ { ref: { path }, data: () => {...} } ] }
function createFirestoreMock(getHandler) {
  function collection(name) {
    const queries = [];
    function where(field, op, value) {
      queries.push({ field, op, value });
      return { where, limit, get };
    }
    function limit(n) {
      queries.push({ limit: n });
      return { where, limit, get };
    }
    async function get() {
      return getHandler(name, queries.slice());
    }
    function doc(id) {
      return {
        collection: (sub) => {
          // For merchants/{merchantId}/collection('inventory') we need to chain.
          const parentCollection = `${name}/${id}/${sub}`;
          return createSubCollection(parentCollection);
        },
      };
    }
    function createSubCollection(fullName) {
      return {
        where(field, op, value) {
          const queries2 = [{ field, op, value }];
          return { get: () => getHandler(fullName, queries2) };
        },
      };
    }

    return { where, limit, get, doc, collection: createSubCollection };
  }

  function batch() {
    const sets = [];
    return {
      set(ref, data, opts) {
        sets.push({ ref, data, opts });
      },
      commit: async () => ({ sets }),
      _sets: sets,
    };
  }

  return { collection, batch };
}

// Helper to build a snapshot with given doc datas and paths
function makeSnapshot(docsArray) {
  const docs = (docsArray || []).map((d, idx) => ({
    ref: { path: d.path || `path/doc-${idx}` },
    data: () => (d.data || {}),
  }));
  return { empty: docs.length === 0, docs };
}

describe("POST /api/items/set-category-id", () => {
  beforeEach(() => {
    // reset the mock factory pointer to a safe default
    squareModuleMock.__setCreateSquareClientFactory(() => async () => ({ catalogApi: {} }));
    jest.clearAllMocks();
  });

  test("returns 400 when merchantId missing", async () => {
    const firestore = createFirestoreMock(async () => makeSnapshot([]));
    const app = express();
    app.use(express.json());
    app.use(buildItemsSetCategoryIdRouter({ firestore, requireLogin }));

    const res = await request(app).post("/api/items/set-category-id").send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "Missing merchantId" });
  });

  test("returns 404 when Square retrieve returns no object", async () => {
    // Provide square client that returns result.object = null
    squareModuleMock.__setCreateSquareClientFactory(() => async () => {
      return {
        catalogApi: {
          retrieveCatalogObject: jest.fn().mockResolvedValue({ result: { object: null } }),
        },
      };
    });

    const firestore = createFirestoreMock(async () => makeSnapshot([]));
    const app = express();
    app.use(express.json());
    app.use(buildItemsSetCategoryIdRouter({ firestore, requireLogin }));

    const res = await request(app)
      .post("/api/items/set-category-id")
      .send({ merchantId: "m1", itemId: "i1", categoryId: "c1" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toContain("Square object not found");
  });

  test("returns 400 when ITEM_VARIATION lacks itemVariationData.itemId", async () => {
    squareModuleMock.__setCreateSquareClientFactory(() => async () => {
      return {
        catalogApi: {
          retrieveCatalogObject: jest.fn().mockResolvedValue({ result: { object: { type: "ITEM_VARIATION", itemVariationData: {} } } }),
        },
      };
    });

    const firestore = createFirestoreMock(async () => makeSnapshot([]));
    const app = express();
    app.use(express.json());
    app.use(buildItemsSetCategoryIdRouter({ firestore, requireLogin }));

    const res = await request(app)
      .post("/api/items/set-category-id")
      .send({ merchantId: "m1", itemId: "var1", categoryId: "c1" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toContain("missing itemVariationData.itemId");
  });

  test("successful flow: updates Square and Firestore, returns expected payload", async () => {
    const merchantId = "merch1";
    const itemIdRaw = "item123";
    const categoryId = "catA";
    const targetItemId = itemIdRaw; // we'll simulate ITEM given directly

    // Prepare a square client whose behavior differs by method
    const retrieveMock = jest.fn();
    const upsertMock = jest.fn();

    // First retrieve (initial) returns ITEM object with version BigInt(2)
    retrieveMock.mockImplementation(async (id, flag) => {
      if (id === targetItemId) {
        return {
          result: {
            object: {
              id,
              type: "ITEM",
              version: BigInt(2),
              itemData: {},
            },
          },
        };
      }
      // verify retrieve after upsert: return categories + reportingCategory set
      return {
        result: {
          object: {
            id,
            type: "ITEM",
            version: BigInt(3),
            itemData: {
              categories: [{ id: categoryId }],
              reportingCategory: { id: categoryId },
            },
          },
        },
      };
    });

    upsertMock.mockResolvedValue({ result: { errors: null, catalogObject: { version: BigInt(3) } } });

    squareModuleMock.__setCreateSquareClientFactory(() => async () => {
      return { catalogApi: { retrieveCatalogObject: retrieveMock, upsertCatalogObject: upsertMock } };
    });

    // Firestore behavior:
    // - square_categories query returns one doc with category_name
    // - merchants/{merchantId}/inventory where item_id==targetItemId returns two docs
    // - merchants/{merchantId}/inventory where variation_id==itemIdRaw returns empty
    // - collection('inventory') where item_id==targetItemId returns one global doc
    const fsGetHandler = async (collectionName, queries) => {
      // Normalize collectionName cases where merchant subcollection was constructed
      if (collectionName === "square_categories") {
        return makeSnapshot([{ path: "square_categories/doc1", data: { category_name: "FS Cat" } }]);
      }

      if (collectionName === `merchants/${merchantId}/inventory`) {
        // check query field
        const q = (queries[0] && queries[0].field) || null;
        if (q === "item_id") {
          return makeSnapshot([
            { path: `merchants/${merchantId}/inventory/doc1`, data: { item_id: targetItemId } },
            { path: `merchants/${merchantId}/inventory/doc2`, data: { item_id: targetItemId } },
          ]);
        }
        if (q === "variation_id") {
          return makeSnapshot([]);
        }
      }

      if (collectionName === "inventory") {
        const q = (queries[0] && queries[0].field) || null;
        if (q === "item_id") {
          return makeSnapshot([
            { path: `inventory/docG1`, data: { item_id: targetItemId } },
          ]);
        }
      }

      // Default empty
      return makeSnapshot([]);
    };

    const firestore = createFirestoreMock(fsGetHandler);

    const app = express();
    app.use(express.json());
    app.use(buildItemsSetCategoryIdRouter({ firestore, requireLogin }));

    const res = await request(app)
      .post("/api/items/set-category-id")
      .send({ merchantId, itemId: itemIdRaw, categoryId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.merchantId).toBe(merchantId);
    expect(res.body.itemIdRaw).toBe(itemIdRaw);
    expect(res.body.targetItemId).toBe(targetItemId);
    expect(res.body.categoryId).toBe(categoryId);
    expect(res.body.categoryName).toBe("FS Cat");
    expect(res.body.categoryIdsInSquare).toEqual([categoryId]);
    expect(res.body.reportingCategoryIdInSquare).toBe(categoryId);
    // version should be stringified BigInt from upsert result
    expect(typeof res.body.version).toBe("string");
    expect(res.body.version).toBe(String(BigInt(3)));
    // updatedInventoryDocs should be number of docs updated in merchants inventory (2)
    expect(res.body.updatedInventoryDocs).toBe(2);

    // Ensure upsert was called with categories and reportingCategory set
    expect(upsertMock).toHaveBeenCalled();
    const upsertArg = upsertMock.mock.calls[0][0];
    expect(upsertArg).toHaveProperty("object");
    const itemData = upsertArg.object.itemData || {};
    expect(itemData.categories).toEqual([{ id: categoryId }]);
    // reportingCategory(s) presence
    expect(itemData.reportingCategory || itemData.reporting_category).toBeTruthy();
  });
});
