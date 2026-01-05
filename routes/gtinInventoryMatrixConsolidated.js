// routes/gtinInventoryMatrixConsolidated.js
const express = require("express");
const router = express.Router();

const { canonicalGtin } = require("../lib/gtin");

async function getLocations(firestore) {
  const locSnap = await firestore.collection("location_index").get();

  const rows = locSnap.docs
    .map(d => d.data() || {})
    .filter(r => r.locKey);

  // Stable order by label
  rows.sort((a, b) => {
    const al = (a.location_name || a.merchant_name || a.locKey || "").toString();
    const bl = (b.location_name || b.merchant_name || b.locKey || "").toString();
    return al.localeCompare(bl);
  });

  const locations = rows.map(r => r.locKey);

  const locationsMeta = {};
  for (const r of rows) {
    locationsMeta[r.locKey] = {
      locKey: r.locKey,
      label: r.merchant_name || r.location_name || r.locKey,
      merchant_id: r.merchant_id || null,
      merchant_name: r.merchant_name || null,
    };
  }

  return { locations, locationsMeta };
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

module.exports = function buildGtinInventoryMatrixConsolidatedRouter({
  requireLogin,
  firestore,
}) {
  router.get("/api/gtin-inventory-matrix", requireLogin, async (req, res) => {
    
    // 🔥 FORCE NO CACHE
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Surrogate-Control": "no-store",
    });
    
    
    try {
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 250);
      const cursor = req.query.cursor || null;

      const mismatchOnly =
        req.query.mismatchOnly === "1" || req.query.mismatchOnly === "true";

      // ✅ NEW: "missing in store" server-side filter
      const missingOnly =
        req.query.missingOnly === "1" || req.query.missingOnly === "true";
      const missingTarget = (req.query.missingTarget || "").toString().trim(); // locKey
      const missingRequirePresentIn = (req.query.missingRequirePresentIn || "")
        .toString()
        .trim(); // optional locKey

      // Optional: let UI force field for prefix mode
      const searchFieldRaw = (req.query.searchField || "name")
        .toString()
        .toLowerCase();
      const searchField = searchFieldRaw === "sku" ? "sku" : "name";

      const qRaw = (req.query.q || "").trim();
      const qLower = qRaw.toLowerCase();
      const hasQuery = !!qRaw;

      const qNoSpace = qLower.replace(/\s+/g, "");
      const isDigits = /^[0-9]+$/.test(qNoSpace);

      const colRef = firestore.collection("gtin_inventory_matrix");
      const { locations, locationsMeta } = await getLocations(firestore);

      // ✅ Validate missingTarget if missingOnly requested
      if (missingOnly) {
        if (!missingTarget) {
          return res.status(400).json({
            error: "missingTarget is required when missingOnly=1",
          });
        }
        if (!locations.includes(missingTarget)) {
          return res.status(400).json({
            error: `missingTarget must be one of locations (locKey). Got: ${missingTarget}`,
          });
        }
        if (
          missingRequirePresentIn &&
          !locations.includes(missingRequirePresentIn)
        ) {
          return res.status(400).json({
            error: `missingRequirePresentIn must be one of locations (locKey). Got: ${missingRequirePresentIn}`,
          });
        }
      }

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
          query = colRef
            .orderBy("__name__")
            .startAt(canonical)
            .endAt(canonical)
            .limit(pageSize);
          cursorMode = "docId";
          keyField = "__name__";
        } else {
          // 2) Token mode for things like 200ml, 750ml, 12pk, 1l
          const token = makeSearchKey(qRaw); // "200 ml" -> "200ml"
          const looksLikeSize =
            /^\d+(\.\d+)?[a-z]+$/.test(token) && token.length <= 10;

          if (looksLikeSize) {
            cursorMode = "token";
            // For token mode, use a stable order so we can paginate if needed
            // (requires composite index if mismatchOnly is used)
            query = colRef.where("search_tokens", "array-contains", token);

            if (mismatchOnly) query = query.where("has_mismatch", "==", true);

            // stable pagination
            query = query
              .orderBy("price_spread", "desc")
              .orderBy("__name__")
              .limit(pageSize);
            keyField = "price_spread";
          } else {
            // 3) Prefix mode (fast indexed)
            cursorMode = "prefix";
            const matchKey = makeSearchKey(qRaw);
            keyField = searchField === "sku" ? "sku_key" : "name_key";

            query = colRef.orderBy(keyField).orderBy("__name__");
            if (mismatchOnly) query = query.where("has_mismatch", "==", true);

            query = query
              .startAt(matchKey)
              .endAt(matchKey + "\uf8ff")
              .limit(pageSize);
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
          if (
            c &&
            (typeof c.s === "number" || typeof c.s === "string") &&
            typeof c.id === "string"
          ) {
            const spread = Number(c.s);
            if (Number.isFinite(spread)) query = query.startAfter(spread, c.id);
          }
        }
      }

      // ✅ Helper to determine if a row is "missing" in a target locKey
      function isMissingRow(row) {
        // UI expects r.pricesByLocation; keep compatible with your build script.
        const pb =
          row?.pricesByLocation ||
          row?.prices_by_location ||
          row?.locations || // fallback if your matrix uses "locations" map
          {};

        const missingInTarget = !pb?.[missingTarget];
        if (!missingInTarget) return false;

        // optional: only show if present in a specific base location
        if (missingRequirePresentIn) {
          if (!pb?.[missingRequirePresentIn]) return false;
        }

        // sanity: must exist somewhere (avoid totally empty GTIN docs)
        const existsSomewhere =
          pb && typeof pb === "object" && Object.keys(pb).length > 0;
        return existsSomewhere;
      }

      // -------------------------
      // Fetch rows (with optional "missing" scan)
      // -------------------------
      let rows = [];
      let lastScannedDoc = null;
      let workingQuery = query;

      if (!missingOnly) {
        const snap = await workingQuery.get();
        rows = snap.docs.map((d) => ({ gtin: d.id, ...d.data() }));
        if (snap.size > 0) lastScannedDoc = snap.docs[snap.docs.length - 1];
      } else {
        // When filtering by missing, we must over-fetch then filter in memory,
        // otherwise you can get fewer than pageSize results.
        const HARD_CAP_SCANS = 8; // prevents runaway reads
        const FETCH_MULTIPLIER = 4;
        const scanLimit = Math.min(pageSize * FETCH_MULTIPLIER, 250);

        for (let i = 0; i < HARD_CAP_SCANS; i++) {
          const scanQuery = workingQuery.limit(scanLimit);
          const snap = await scanQuery.get();

          if (snap.size === 0) break;
          lastScannedDoc = snap.docs[snap.docs.length - 1];

          for (const d of snap.docs) {
            const row = { gtin: d.id, ...d.data() };
            if (isMissingRow(row)) rows.push(row);
            if (rows.length >= pageSize) break;
          }
          if (rows.length >= pageSize) break;

          // Continue scanning after last scanned doc
          if (!lastScannedDoc) break;

          if (cursorMode === "docId") {
            workingQuery = query.startAfter(lastScannedDoc);
          } else if (cursorMode === "prefix") {
            const lastKey = (lastScannedDoc.data()?.[keyField] || "").toString();
            workingQuery = query.startAfter(lastKey, lastScannedDoc.id);
          } else if (cursorMode === "token") {
            const lastSpread = Number(lastScannedDoc.data()?.price_spread ?? 0);
            workingQuery = query.startAfter(lastSpread, lastScannedDoc.id);
          }

          // If we scanned fewer than scanLimit docs, there’s nothing left
          if (snap.size < scanLimit) break;
        }
      }

      // -------------------------
      // Next cursor
      // -------------------------
      let nextCursor = null;

      // IMPORTANT:
      // For missingOnly scans, cursor must advance based on the LAST SCANNED doc,
      // not the last returned row, otherwise pagination can loop/repeat.
      if (lastScannedDoc) {
        if (cursorMode === "docId") {
          nextCursor = lastScannedDoc.id;
        } else if (cursorMode === "prefix") {
          const lastKey = (lastScannedDoc.data()?.[keyField] || "").toString();
          nextCursor = encodeCursor({ k: lastKey, id: lastScannedDoc.id });
        } else if (cursorMode === "token") {
          const lastSpread = Number(lastScannedDoc.data()?.price_spread ?? 0);
          nextCursor = encodeCursor({ s: lastSpread, id: lastScannedDoc.id });
        }
      }

      return res.json({ rows, locations, locationsMeta, nextCursor });
    } catch (err) {
      console.error("Error in /api/gtin-inventory-matrix:", err);
      return res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  return router;
};
