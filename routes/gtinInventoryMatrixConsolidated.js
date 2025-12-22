// routes/gtinInventoryMatrixConsolidated.js
const express = require("express");
const router = express.Router();

const { canonicalGtin } = require("../lib/gtin");

// ------------------------------
// Locations cache (Cloud Run friendly)
// ------------------------------
let _locCache = { value: null, expiresAt: 0 };
async function getLocationsCached(firestore) {
  const now = Date.now();
  if (_locCache.value && now < _locCache.expiresAt) return _locCache.value;

  const locSnap = await firestore.collection("location_index").get();
  const locations = locSnap.docs
    .map((d) => d.data()?.locKey)
    .filter(Boolean)
    .sort();

  _locCache = { value: locations, expiresAt: now + 5 * 60 * 1000 }; // 5 min
  return locations;
}

// Must match build script
function makeSearchKey(s) {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
function decodeCursor(s) {
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = function buildGtinInventoryMatrixConsolidatedRouter({ requireLogin, firestore }) {
  router.get("/api/gtin-inventory-matrix", requireLogin, async (req, res) => {
    try {
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 250);
      const cursor = req.query.cursor || null;

      const mismatchOnly = req.query.mismatchOnly === "1" || req.query.mismatchOnly === "true";

      // Optional: let UI force field for prefix mode
      const searchFieldRaw = (req.query.searchField || "name").toString().toLowerCase();
      const searchField = searchFieldRaw === "sku" ? "sku" : "name";

      const qRaw = (req.query.q || "").trim();
      const qLower = qRaw.toLowerCase();
      const hasQuery = !!qRaw;

      const qNoSpace = qLower.replace(/\s+/g, "");
      const isDigits = /^[0-9]+$/.test(qNoSpace);

      const colRef = firestore.collection("gtin_inventory_matrix");
      const locations = await getLocationsCached(firestore);

      // -------------------------
      // Query mode decision
      // -------------------------
      let query = null;
      let cursorMode = "docId"; // 'docId' | 'prefix' | 'token'
      let keyField = "__name__";

      if (hasQuery) {
        // 1) GTIN exact (fast)
        if (isDigits && qNoSpace.length >= 8) {
          const canonical = canonicalGtin(qNoSpace) || qNoSpace;
          query = colRef.orderBy("__name__").startAt(canonical).endAt(canonical).limit(pageSize);
          cursorMode = "docId";
          keyField = "__name__";
        } else {
          // 2) Token mode for things like 200ml, 750ml, 12pk, 1l
          const token = makeSearchKey(qRaw); // "200 ml" -> "200ml"
          const looksLikeSize = /^\d+(\.\d+)?[a-z]+$/.test(token) && token.length <= 10;

          if (looksLikeSize) {
            cursorMode = "token";
            // For token mode, use a stable order so we can paginate if needed
            // (requires composite index if mismatchOnly is used)
            query = colRef.where("search_tokens", "array-contains", token);

            if (mismatchOnly) query = query.where("has_mismatch", "==", true);

            // stable pagination
            query = query.orderBy("price_spread", "desc").orderBy("__name__").limit(pageSize);
            keyField = "price_spread";
          } else {
            // 3) Prefix mode (fast indexed)
            cursorMode = "prefix";
            const matchKey = makeSearchKey(qRaw);
            keyField = searchField === "sku" ? "sku_key" : "name_key";

            query = colRef.orderBy(keyField).orderBy("__name__");
            if (mismatchOnly) query = query.where("has_mismatch", "==", true);

            query = query.startAt(matchKey).endAt(matchKey + "\uf8ff").limit(pageSize);
          }
        }
      } else {
        // default list
        query = colRef.orderBy("__name__").limit(pageSize);
        if (mismatchOnly) query = query.where("has_mismatch", "==", true);
        cursorMode = "docId";
        keyField = "__name__";
      }

      // -------------------------
      // Cursor handling
      // -------------------------
      if (cursor) {
        if (cursorMode === "docId") {
          const cursorDoc = await colRef.doc(cursor).get();
          if (cursorDoc.exists) query = query.startAfter(cursorDoc);
        } else if (cursorMode === "prefix") {
          // base64 JSON: { k: <keyFieldValue>, id: <docId> }
          const c = decodeCursor(cursor);
          if (c && typeof c.k === "string" && typeof c.id === "string") {
            query = query.startAfter(c.k, c.id);
          }
        } else if (cursorMode === "token") {
          // base64 JSON: { s: <price_spread>, id: <docId> }
          const c = decodeCursor(cursor);
          if (c && (typeof c.s === "number" || typeof c.s === "string") && typeof c.id === "string") {
            const spread = Number(c.s);
            if (Number.isFinite(spread)) query = query.startAfter(spread, c.id);
          }
        }
      }

      const snap = await query.get();
      const rows = snap.docs.map((d) => ({ gtin: d.id, ...d.data() }));

      // -------------------------
      // Next cursor
      // -------------------------
      let nextCursor = null;
      if (snap.size > 0) {
        const last = snap.docs[snap.docs.length - 1];

        if (cursorMode === "docId") {
          nextCursor = last.id;
        } else if (cursorMode === "prefix") {
          const lastKey = (last.data()?.[keyField] || "").toString();
          nextCursor = encodeCursor({ k: lastKey, id: last.id });
        } else if (cursorMode === "token") {
          const lastSpread = Number(last.data()?.price_spread ?? 0);
          nextCursor = encodeCursor({ s: lastSpread, id: last.id });
        }
      }

      return res.json({ rows, locations, nextCursor });
    } catch (err) {
      console.error("Error in /api/gtin-inventory-matrix:", err);
      return res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  return router;
};
