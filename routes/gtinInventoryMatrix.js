const express = require("express");
const router = express.Router();

module.exports = function buildGtinInventoryMatrixRouter({ requireLogin, firestore }) {
  router.get("/api/gtin-inventory-matrix", requireLogin, async (req, res) => {
    try {
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 250);
      const cursor = req.query.cursor || null;

      const qRaw = (req.query.q || "").trim().toLowerCase();
      const qNoSpace = qRaw.replace(/\s+/g, "");
      const hasQuery = !!qRaw;
      const isDigits = /^[0-9]+$/.test(qNoSpace);

      const merchantId = req.query.merchantId;
      if (!merchantId) return res.status(400).json({ error: "merchantId required" });

      const colRef = firestore
        .collection("merchants")
        .doc(merchantId)
        .collection("gtin_inventory_matrix");

      let query;
      let cursorMode = "docId";

      if (hasQuery) {
        if (isDigits && qNoSpace.length >= 8) {
          query = colRef.orderBy("__name__").startAt(qNoSpace).endAt(qNoSpace).limit(pageSize);
          cursorMode = "docId";
        } else {
          cursorMode = "scan";
        }
      } else {
        query = colRef.orderBy("__name__").limit(pageSize);
        cursorMode = "docId";
      }

      // merchant-scoped locations
      const locSnap = await firestore
        .collection("merchants")
        .doc(merchantId)
        .collection("location_index")
        .get();

      const locations = locSnap.docs
        .map(d => d.data()?.locKey)
        .filter(Boolean)
        .sort();

      if (cursorMode === "scan") {
        const matchNorm = qNoSpace;
        const collected = [];
        const batchSize = 400;

        let lastId = cursor || null;
        let lastSnap = null;
        let reachedLimit = false;

        while (!reachedLimit) {
          let qBatch = colRef.orderBy("__name__").limit(batchSize);
          if (lastId) {
            const cursorDoc = await colRef.doc(lastId).get();
            if (cursorDoc.exists) qBatch = qBatch.startAfter(cursorDoc);
          }

          const snap = await qBatch.get();
          lastSnap = snap;
          if (snap.empty) break;

          for (const doc of snap.docs) {
            lastId = doc.id;
            const d = doc.data() || {};

            const nameNorm = (d.item_name_lc || d.item_name || "").toString().toLowerCase().replace(/\s+/g, "");
            const skuNorm = (d.sku || "").toString().toLowerCase().replace(/\s+/g, "");

            if (!matchNorm || nameNorm.includes(matchNorm) || skuNorm.includes(matchNorm)) {
              collected.push({ gtin: doc.id, ...d });
              if (collected.length >= pageSize) {
                reachedLimit = true;
                break;
              }
            }
          }

          if (snap.size < batchSize) break;
        }

        let nextCursor = null;
        if (lastSnap && lastSnap.size === batchSize && lastId && collected.length >= pageSize) {
          nextCursor = lastId;
        }

        return res.json({ rows: collected, locations, nextCursor });
      }

      if (cursor && cursorMode === "docId") {
        const cursorDoc = await colRef.doc(cursor).get();
        if (cursorDoc.exists) query = query.startAfter(cursorDoc);
      }

      const snap = await query.get();
      const rows = snap.docs.map(d => ({ gtin: d.id, ...d.data() }));

      let nextCursor = null;
      if (snap.size > 0) nextCursor = snap.docs[snap.docs.length - 1].id;

      res.json({ rows, locations, nextCursor });
    } catch (err) {
      console.error("Error in /api/gtin-inventory-matrix:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  return router;
};
