const request = require("supertest");
const express = require("express");

const buildRouter = require("../routes/gtinInventoryMatrixConsolidated");

// Minimal Firestore stub for this route
function makeFirestoreStub() {
  return {
    collection: (name) => {
      // location_index is read on every request (cached in your route)
      if (name === "location_index") {
        return {
          get: async () => ({
            docs: [
              { data: () => ({ locKey: "Store A – Default" }) },
              { data: () => ({ locKey: "Store B – Default" }) },
            ],
          }),
        };
      }

      // gtin_inventory_matrix query
      if (name === "gtin_inventory_matrix") {
        const fakeDocs = [
          { id: "008421372232", data: () => ({ item_name: "Titos Vodka 200ml", name_key: "titosvodka200ml", has_mismatch: false }) },
          { id: "008421372233", data: () => ({ item_name: "Titos Vodka 750ml", name_key: "titosvodka750ml", has_mismatch: true }) },
        ];

        // Provide minimal chainable query interface used by your route
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          startAt: () => chain,
          endAt: () => chain,
          limit: () => chain,
          startAfter: () => chain,
          get: async () => ({ size: fakeDocs.length, docs: fakeDocs }),
          doc: (id) => ({
            get: async () => ({
              exists: fakeDocs.some((d) => d.id === id),
              id,
              data: () => fakeDocs.find((d) => d.id === id)?.data() || null,
            }),
          }),
        };
        return chain;
      }

      throw new Error(`Unexpected collection(${name}) in test stub`);
    },
  };
}

describe("Sanity: /api/gtin-inventory-matrix route", () => {
  test("responds 200 and returns rows+locations (with stubs)", async () => {
    const app = express();

    const requireLogin = (req, res, next) => next(); // bypass auth for tests
    const firestore = makeFirestoreStub();

    app.use(buildRouter({ requireLogin, firestore }));

    const res = await request(app).get("/api/gtin-inventory-matrix?pageSize=10&q=titos");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(Array.isArray(res.body.locations)).toBe(true);
  });

  test("GTIN digits query works (docId fast-path)", async () => {
    const app = express();
    const requireLogin = (req, res, next) => next();
    const firestore = makeFirestoreStub();

    app.use(buildRouter({ requireLogin, firestore }));

    const res = await request(app).get("/api/gtin-inventory-matrix?q=008421372232");
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.body.rows[0].gtin).toBe("008421372232");
  });
});
