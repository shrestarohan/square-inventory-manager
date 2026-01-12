"use strict";

const express = require("express");
const request = require("supertest");

// We'll reset modules between tests so we can control mocks per-run
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks?.();
});

// Helper to build an app with the router under test, injecting mocks
async function buildApp({ firestoreMock, makeCreateSquareClientForMerchantMock, axiosMock, sharpMock }) {
  // Mock axios and sharp modules as needed before requiring the router
  if (axiosMock) {
    jest.doMock("axios", () => axiosMock);
  }
  if (sharpMock) {
    jest.doMock("sharp", () => sharpMock);
  }

  // The route file does: const { makeCreateSquareClientForMerchant } = require("../lib/square");
  // That resolves to <repoRoot>/lib/square when required from routes/itemImages.js.
  // From this test file (located in __tests__/generated) the path to that module is ../../lib/square
  if (makeCreateSquareClientForMerchantMock) {
    jest.doMock("../../lib/square", () => ({
      makeCreateSquareClientForMerchant: makeCreateSquareClientForMerchantMock,
    }));
  }

  // Now require the router (fresh import)
  const buildRouter = require("../../routes/itemImages");

  // create minimal requireLogin middleware
  const requireLogin = (req, res, next) => {
    req.user = { id: "test-user" };
    return next();
  };

  const app = express();
  app.use(buildRouter({ firestore: firestoreMock, requireLogin }));
  return app;
}

// Utility to create a mock Firestore compatible with the route's usage
function createMockFirestore({ inventoryDocs = [], merchants = {} } = {}) {
  // Make shallow copies
  const invDocs = inventoryDocs.map((d, idx) => ({
    id: d.id || `inv-${idx}`,
    data: () => d.data,
    ref: { _path: `inventory/${d.id || `inv-${idx}`}` },
  }));

  const batch = {
    set: jest.fn(),
    commit: jest.fn(() => Promise.resolve()),
  };

  const collections = new Map();

  const collectionFn = (name) => {
    if (name === "inventory") {
      return {
        where: (field, op, val) => {
          return {
            get: () => Promise.resolve({ empty: invDocs.length === 0, docs: invDocs }),
          };
        },
        doc: (id) => ({ id, collection: () => ({}) }),
      };
    }

    if (name === "merchants") {
      return {
        doc: (id) => ({
          get: () => Promise.resolve({ exists: !!merchants[id], data: () => merchants[id] || {} }),
          collection: () => ({
            doc: (docId) => ({ _path: `merchants/${id}/inventory/${docId}` }),
          }),
        }),
      };
    }

    if (name === "item_master") {
      return {
        doc: (id) => ({ set: jest.fn(() => Promise.resolve()) }),
      };
    }

    // Fallback: return something that covers batch/.doc usage
    return {
      doc: (id) => ({ get: () => Promise.resolve({ exists: false }) }),
      collection: () => ({ doc: (id) => ({}) }),
    };
  };

  return {
    collection: collectionFn,
    batch: () => batch,
    _internal: { batch }, // expose for assertions
  };
}

// Simple axios mock factory
function makeAxiosMock() {
  return { post: jest.fn() };
}

// Simple sharp mock factory used for webp -> jpeg conversion
function makeSharpMock() {
  const mock = jest.fn((inputBuffer) => ({
    jpeg: () => ({
      toBuffer: () => Promise.resolve(Buffer.from("jpeg-bytes")),
    }),
  }));
  return mock;
}

describe("POST /api/update-item-image - validations", () => {
  test("returns 400 when gtin is missing", async () => {
    const firestore = createMockFirestore();
    const axiosMock = makeAxiosMock();
    const makeCreateSquareClientForMerchantMock = jest.fn(() => async () => ({}));

    const app = await buildApp({ firestoreMock: firestore, makeCreateSquareClientForMerchantMock, axiosMock });

    const res = await request(app).post("/api/update-item-image").attach("image", Buffer.from("x"), "foo.jpg");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: "gtin is required" });
  });

  test("returns 400 when image is missing", async () => {
    const firestore = createMockFirestore();
    const axiosMock = makeAxiosMock();
    const makeCreateSquareClientForMerchantMock = jest.fn(() => async () => ({}));

    const app = await buildApp({ firestoreMock: firestore, makeCreateSquareClientForMerchantMock, axiosMock });

    const res = await request(app).post("/api/update-item-image").field("gtin", "0123456789012");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: "image file is required" });
  });

  test("returns 404 when no inventory rows found for gtin", async () => {
    const firestore = createMockFirestore({ inventoryDocs: [] });
    const axiosMock = makeAxiosMock();
    const makeCreateSquareClientForMerchantMock = jest.fn(() => async () => ({}));

    const app = await buildApp({ firestoreMock: firestore, makeCreateSquareClientForMerchantMock, axiosMock });

    const res = await request(app)
      .post("/api/update-item-image")
      .field("gtin", "0000")
      .attach("image", Buffer.from("x"), "foo.jpg");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.error).toMatch(/No inventory rows found for gtin/);
  });
});

describe("POST /api/update-item-image - flows", () => {
  test("skips merchant when access_token missing and returns 400 overall", async () => {
    const inv = [
      { id: "doc1", data: { merchant_id: "m1", item_id: "item-1" } },
    ];

    const merchants = {
      m1: { /* missing access_token */ },
    };

    const firestore = createMockFirestore({ inventoryDocs: inv, merchants });

    const axiosMock = makeAxiosMock();
    const makeCreateSquareClientForMerchantMock = jest.fn(() => async () => ({}));

    const app = await buildApp({ firestoreMock: firestore, makeCreateSquareClientForMerchantMock, axiosMock });

    const res = await request(app)
      .post("/api/update-item-image")
      .field("gtin", "GTIN-1")
      .attach("image", Buffer.from("x"), "foo.png");

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.gtin).toBe("GTIN-1");
    expect(res.body.updatedMerchants).toBe(0);
    expect(res.body.skippedMerchants).toBeGreaterThanOrEqual(1);
    // ensure we get at least one result describing the error
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.some(r => r.error && r.error.includes("Missing access_token"))).toBe(true);
  });

  test("successful upload persists firstImageUrl and updates inventory (non-webp)", async () => {
    const inv = [
      { id: "docA", data: { merchant_id: "m42", item_id: "item-A" } },
    ];

    const merchants = {
      m42: { access_token: "tok-abc", env: "sandbox" },
    };

    const firestore = createMockFirestore({ inventoryDocs: inv, merchants });

    const axiosMock = makeAxiosMock();
    // axios responds with an object that includes image.image_data.url
    axiosMock.post.mockResolvedValueOnce({
      status: 200,
      data: { image: { id: "image-123", image_data: { url: "https://cdn.example/img.jpg" } } },
    });

    const makeCreateSquareClientForMerchantMock = jest.fn(() => async () => ({ /* client object stub */ }));

    const app = await buildApp({ firestoreMock: firestore, makeCreateSquareClientForMerchantMock, axiosMock });

    const res = await request(app)
      .post("/api/update-item-image")
      .field("gtin", "GTIN-XYZ")
      .attach("image", Buffer.from("pngdata"), "prod.png");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gtin).toBe("GTIN-XYZ");
    expect(res.body.firstImageUrl).toBe("https://cdn.example/img.jpg");
    expect(res.body.updatedMerchants).toBe(1);
    expect(res.body.skippedMerchants).toBe(0);
    expect(res.body.resultsCount).toBeGreaterThan(0);
    expect(res.body.convertedFromWebp).toBe(false);

    // Verify axios was called (upload to Square)
    expect(axiosMock.post).toHaveBeenCalled();

    // Verify item_master.set was called via the mocked firestore
    const itemMasterDoc = firestore.collection("item_master").doc("GTIN-XYZ");
    // In our mock item_master.doc(id).set was a jest.fn inside createMockFirestore.
    // Retrieve it by calling collection('item_master').doc(...).set (we didn't store the fn externally),
    // but we can still assert that batch.commit was called once during the inventory update.
    expect(firestore._internal.batch.commit).toHaveBeenCalled();
  });

  test("webp input is converted to jpeg and flagged convertedFromWebp", async () => {
    const inv = [
      { id: "docW", data: { merchant_id: "mW", item_id: "item-W" } },
    ];
    const merchants = { mW: { access_token: "tok-webp" } };
    const firestore = createMockFirestore({ inventoryDocs: inv, merchants });

    const axiosMock = makeAxiosMock();
    axiosMock.post.mockResolvedValueOnce({
      status: 200,
      data: { image: { id: "img-webp", image_data: { url: "https://cdn.example/img-webp.jpg" } } },
    });

    // Mock sharp so conversion returns a deterministic buffer
    const sharpMock = makeSharpMock();

    const makeCreateSquareClientForMerchantMock = jest.fn(() => async () => ({}));

    const app = await buildApp({ firestoreMock: firestore, makeCreateSquareClientForMerchantMock, axiosMock, sharpMock });

    const res = await request(app)
      .post("/api/update-item-image")
      .field("gtin", "GTIN-WEBP")
      // Simulate a webp upload by naming the file .webp and content-type
      .attach("image", Buffer.from("webp-bits"), { filename: "uploader.webp", contentType: "image/webp" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.firstImageUrl).toBe("https://cdn.example/img-webp.jpg");
    expect(res.body.convertedFromWebp).toBe(true);

    // Ensure sharp was called to perform conversion
    expect(sharpMock).toHaveBeenCalled();
    // And axios called
    expect(axiosMock.post).toHaveBeenCalled();
  });
});
