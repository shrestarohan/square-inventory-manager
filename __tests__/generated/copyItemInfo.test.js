// Jest tests for routes/copyItemInfo.js
// Run with: jest --runInBand

const express = require("express");
const request = require("supertest");

// Mock the square/legacy module before requiring the route code so their import is replaced
jest.mock("square/legacy", () => {
  class MockClient {
    constructor(opts) {
      this.environment = opts.environment;
      this.accessToken = opts.accessToken;
      // expose catalogApi that delegates to static mocks set by tests
      this.catalogApi = {
        upsertCatalogObject: (body) => MockClient._mocks.upsertCatalogObject(body),
        batchRetrieveCatalogObjects: (body) => MockClient._mocks.batchRetrieveCatalogObjects(body),
        batchUpsertCatalogObjects: (body) => MockClient._mocks.batchUpsertCatalogObjects(body),
      };
    }
  }
  MockClient._mocks = {
    upsertCatalogObject: async () => ({ result: { idMappings: [], catalogObject: null } }),
    batchRetrieveCatalogObjects: async () => ({ result: { objects: [] } }),
    batchUpsertCatalogObjects: async () => ({ result: { objects: [] } }),
  };

  return {
    Client: MockClient,
    Environment: { Sandbox: "Sandbox", Production: "Production" },
  };
});

const { Client: MockSquareClient } = require("square/legacy");

// Minimal in-memory Firestore mock implementing only what's used by the route
class MockFirestore {
  constructor(initial = {}) {
    // store documents keyed by full path: e.g. 'location_index/<docId>' or 'merchants/<mid>/inventory/<gtin>'
    this.store = Object.assign({}, initial);
  }

  // normalize path helper
  _docPath(collectionPath, id) {
    return `${collectionPath}/${id}`;
  }

  collection(name) {
    const self = this;
    const base = name;
    return {
      doc(id) {
        const path = self._docPath(base, id);
        return new DocumentReference(self, path);
      },
      where(field, op, value) {
        // return a simple query object for this collection
        const collPath = base; // might be full nested path when created via doc().collection()
        return new Query(self, collPath, [{ field, op, value }]);
      },
      async get() {
        // Unused in tests
        return { empty: true, docs: [] };
      },
      add: async (data) => {
        // add to collection top-level with generated id
        const id = `auto_${Math.random().toString(36).slice(2)}`;
        self.store[`${base}/${id}`] = Object.assign({}, data);
        return { id };
      },
    };
  }
}

class DocumentReference {
  constructor(firestore, path) {
    this._fs = firestore;
    this.path = path;
  }

  async get() {
    const data = this._fs.store[this.path];
    return { exists: !!data, data: () => (data ? Object.assign({}, data) : undefined) };
  }

  async set(data, opts) {
    if (opts && opts.merge) {
      const prev = this._fs.store[this.path] || {};
      this._fs.store[this.path] = Object.assign({}, prev, data);
    } else {
      this._fs.store[this.path] = Object.assign({}, data);
    }
    return true;
  }

  collection(name) {
    // support nested collection under this doc path
    const base = `${this.path}/${name}`;
    const selfFs = this._fs;
    return {
      doc: (id) => new DocumentReference(selfFs, `${base}/${id}`),
      where: (field, op, value) => new Query(selfFs, base, [{ field, op, value }]),
    };
  }
}

class Query {
  constructor(firestore, collectionPath, clauses = []) {
    this._fs = firestore;
    this.collectionPath = collectionPath; // e.g. 'merchants/m1/inventory'
    this.clauses = clauses;
    this._limit = null;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  async get() {
    const docs = [];
    const prefix = `${this.collectionPath}/`;
    for (const key of Object.keys(this._fs.store)) {
      if (!key.startsWith(prefix)) continue;
      // ensure direct child (no extra slashes beyond collectionPath/<id>)
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      const data = this._fs.store[key];
      let ok = true;
      for (const c of this.clauses) {
        if (c.op === "==") {
          if ((data || {})[c.field] !== c.value) ok = false;
        } else {
          ok = false;
        }
      }
      if (ok) docs.push(new QueryDocumentSnapshot(key, data));
      if (this._limit && docs.length >= this._limit) break;
    }
    return { empty: docs.length === 0, docs };
  }
}

class QueryDocumentSnapshot {
  constructor(path, data) {
    this._path = path;
    this._data = data;
  }
  data() {
    return Object.assign({}, this._data);
  }
}

// Helper to compute locIdForKey same as in module
function locIdForKey(locKey) {
  return Buffer.from(locKey, "utf8").toString("base64").replace(/=+$/g, "");
}

// Now require the router factory
const buildCopyItemInfoRouter = require("../../routes/copyItemInfo");

// A simple requireLogin middleware for tests
function requireLogin(req, res, next) {
  req.user = { email: "tester@example.com", id: "user1" };
  next();
}

describe("POST /api/copy-item-info", () => {
  let app;
  let fs;
  const GTIN = "0811538010405";

  beforeEach(() => {
    // Reset env defaults
    process.env.SQUARE_ACCESS_TOKEN = "";
    process.env.SQUARE_ENV = "sandbox";

    // Reset square mocks to defaults (tests will override as needed)
    MockSquareClient._mocks.upsertCatalogObject = async () => ({ result: { idMappings: [], catalogObject: null } });
    MockSquareClient._mocks.batchRetrieveCatalogObjects = async () => ({ result: { objects: [] } });
    MockSquareClient._mocks.batchUpsertCatalogObjects = async () => ({ result: { objects: [] } });

    fs = new MockFirestore();

    app = express();
    app.use(express.json());
    app.use(buildCopyItemInfoRouter({ requireLogin, firestore: fs }));
  });

  test("returns 400 when gtin missing", async () => {
    const res = await request(app).post("/api/copy-item-info").send({ gtin: "", fromLocKey: "a", toLocKey: "b" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Missing gtin/);
  });

  test("creates new Square item + updates matrix when destination missing", async () => {
    // Provide env token so getSquareAccessTokenForMerchant uses it and does not read merchants docs
    process.env.SQUARE_ACCESS_TOKEN = "env-token-123";

    const fromLocKey = "from-loc-key-1";
    const toLocKey = "to-loc-key-2";
    const fromDocId = locIdForKey(fromLocKey);
    const toDocId = locIdForKey(toLocKey);

    // Prepare Firestore initial data
    fs.store[`location_index/${fromDocId}`] = { merchant_id: "m1", location_id: "L1", location_name: "From" };
    fs.store[`location_index/${toDocId}`] = { merchant_id: "m2", location_id: "L2", location_name: "To" };

    // Source inventory doc for merchant m1
    fs.store[`merchants/m1/inventory/${GTIN}`] = {
      gtin: GTIN,
      item_name: "Cool Thing",
      sku: "SKU123",
      category_name: "Gadgets",
    };

    // Destination inventory does not exist (m2 inventory/GTIN)

    // Matrix doc exists with a price for fromLocKey
    fs.store[`gtin_inventory_matrix/${GTIN}`] = {
      pricesByLocation: {
        [fromLocKey]: { price: 12.34, currency: "USD", merchant_id: "m1" },
      },
      currency: "USD",
    };

    // Configure square upsert to return id mappings
    const createdItemId = "sq_item_100";
    const createdVarId = "sq_var_200";

    MockSquareClient._mocks.upsertCatalogObject = async (body) => {
      // ensure idempotency key present
      expect(body).toHaveProperty("idempotencyKey");
      return {
        result: {
          catalogObject: { id: "temp" },
          idMappings: [
            { clientObjectId: `#ITEM_${GTIN}`, objectId: createdItemId },
            { clientObjectId: `#VAR_${GTIN}`, objectId: createdVarId },
          ],
        },
      };
    };

    const res = await request(app)
      .post("/api/copy-item-info")
      .send({ gtin: GTIN, fromLocKey, toLocKey });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.squareResult).toBeDefined();
    expect(res.body.squareResult.ok).toBe(true);
    expect(res.body.squareResult.action).toBe("created");
    expect(res.body.toItemId).toBe(createdItemId);
    expect(res.body.toVariationId).toBe(createdVarId);

    // Verify that destination inventory doc was created and later updated with square ids
    const toInv = fs.store[`merchants/m2/inventory/${GTIN}`];
    expect(toInv).toBeDefined();
    expect(toInv.gtin).toBe(GTIN);
    // created by first FIRESTORE set (placeholder) and then set with item ids
    expect(toInv.item_id).toBe(createdItemId);
    expect(toInv.variation_id).toBe(createdVarId);
    expect(toInv.state).toBe("placeholder");

    // Verify matrix doc updated with toLocKey entry and item/variation ids
    const matrix = fs.store[`gtin_inventory_matrix/${GTIN}`];
    expect(matrix).toBeDefined();
    const pb = matrix.pricesByLocation || {};
    expect(pb[toLocKey]).toBeDefined();
    expect(pb[toLocKey].item_id).toBe(createdItemId);
    expect(pb[toLocKey].variation_id).toBe(createdVarId);
    expect(pb[toLocKey].price).toBe(12.34);
    expect(matrix.has_mismatch).toBeDefined();
    expect(matrix.price_spread).toBeDefined();
  });

  test("updates existing Square item when item_id and variation_id present", async () => {
    process.env.SQUARE_ACCESS_TOKEN = "env-token-xyz";

    const fromLocKey = "flk-update";
    const toLocKey = "tlk-update";
    const fromDocId = locIdForKey(fromLocKey);
    const toDocId = locIdForKey(toLocKey);

    fs.store[`location_index/${fromDocId}`] = { merchant_id: "mA", location_id: "LA", location_name: "FromA" };
    fs.store[`location_index/${toDocId}`] = { merchant_id: "mB", location_id: "LB", location_name: "ToB" };

    fs.store[`merchants/mA/inventory/${GTIN}`] = {
      gtin: GTIN,
      item_name: "Existing Thing",
      sku: "SKUEX",
      category_name: "Stuff",
    };

    // Destination inventory exists and already has square ids
    const existingItemId = "existing_item_1";
    const existingVarId = "existing_var_2";
    fs.store[`merchants/mB/inventory/${GTIN}`] = {
      gtin: GTIN,
      item_id: existingItemId,
      variation_id: existingVarId,
    };

    // Matrix doc present
    fs.store[`gtin_inventory_matrix/${GTIN}`] = {
      pricesByLocation: {
        [fromLocKey]: { price: 5.5, currency: "USD", merchant_id: "mA" },
      },
      currency: "USD",
    };

    // Mock batchRetrieveCatalogObjects to return item + variation
    MockSquareClient._mocks.batchRetrieveCatalogObjects = async (body) => {
      expect(body.objectIds).toEqual([existingItemId, existingVarId]);
      return {
        result: {
          objects: [
            { id: existingItemId, type: "ITEM", itemData: { name: "old" } },
            { id: existingVarId, type: "ITEM_VARIATION", itemVariationData: { sku: "oldsku" } },
          ],
        },
      };
    };

    // Mock batchUpsertCatalogObjects to return updated objects
    MockSquareClient._mocks.batchUpsertCatalogObjects = async (body) => {
      // idempotencyKey present
      expect(body).toHaveProperty("idempotencyKey");
      return {
        result: {
          objects: [
            { id: existingItemId, type: "ITEM" },
            { id: existingVarId, type: "ITEM_VARIATION" },
          ],
        },
      };
    };

    const res = await request(app)
      .post("/api/copy-item-info")
      .send({ gtin: GTIN, fromLocKey, toLocKey });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.squareResult.ok).toBe(true);
    expect(res.body.squareResult.action).toBe("updated");
    expect(res.body.toItemId).toBe(existingItemId);
    expect(res.body.toVariationId).toBe(existingVarId);

    // Matrix updated with the toLocKey
    const matrix = fs.store[`gtin_inventory_matrix/${GTIN}`];
    expect(matrix.pricesByLocation[toLocKey].item_id).toBe(existingItemId);
    expect(matrix.pricesByLocation[toLocKey].variation_id).toBe(existingVarId);
  });

  test("returns 404 if source inventory missing", async () => {
    const fromLocKey = "missing-src";
    const toLocKey = "any-dest";
    const fromDocId = locIdForKey(fromLocKey);
    const toDocId = locIdForKey(toLocKey);

    fs.store[`location_index/${fromDocId}`] = { merchant_id: "mX" };
    fs.store[`location_index/${toDocId}`] = { merchant_id: "mY" };

    // No inventory docs for mX
    fs.store[`gtin_inventory_matrix/${GTIN}`] = { pricesByLocation: {} };

    const res = await request(app)
      .post("/api/copy-item-info")
      .send({ gtin: GTIN, fromLocKey, toLocKey });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Source inventory missing/);
  });
});
