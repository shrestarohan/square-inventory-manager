const express = require("express");
const router = express.Router();

module.exports = function buildGtinMatrixRouter({ requireLogin, firestore }) {
  router.get("/api/gtin-matrix", requireLogin, async (req, res) => {
    try {
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 250);
      const cursor = req.query.cursor || null;

      const qRaw = (req.query.q || "").trim().toLowerCase();
      const qNoSpace = qRaw.replace(/\s+/g, "");
      const hasQuery = !!qRaw;
      const isDigits = /^[0-9]+$/.test(qNoSpace);

      const onlyDuplicates = req.query.onlyDuplicates === "1";

      const merchantId = req.query.merchantId;
      if (!merchantId) return res.status(400).json({ error: "merchantId required" });

      const colRef = firestore.collection("merchants").doc(merchantId).collection("gtin_matrix");

      // Helpers
      const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, "");
      const variationsToArray = (variationsObj) => {
        if (!variationsObj || typeof variationsObj !== "object") return [];
        return Object.values(variationsObj);
      };

      let query;
      let cursorMode = "docId"; // 'docId' | 'scan'

      if (hasQuery) {
        if (isDigits && qNoSpace.length >= 8) {
          // ✅ GTIN-style docId lookup
          // If onlyDuplicates=1, we'll filter after fetch (because docId equality query can’t add where easily)
          query = colRef
            .orderBy("__name__")
            .startAt(qNoSpace)
            .endAt(qNoSpace)
            .limit(pageSize);
          cursorMode = "docId";
        } else {
          cursorMode = "scan";
        }
      } else {
        // No search term
        cursorMode = "docId";
        query = onlyDuplicates
          ? colRef
              .where("variation_count", ">", 1)
              .orderBy("variation_count", "desc")
              .orderBy("__name__")
              .limit(pageSize)
          : colRef.orderBy("__name__").limit(pageSize);
      }

      // ---------- SCAN MODE ----------
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

            if (onlyDuplicates && Number(d.variation_count || 0) <= 1) continue;

            const canonicalNorm = norm(d.canonical_name);
            const vars = variationsToArray(d.variations);

            let varNames = "";
            let varSkus = "";
            for (const v of vars) {
              varNames += " " + norm(v.item_name);
              varSkus += " " + norm(v.sku);
            }

            const hit =
              !matchNorm ||
              canonicalNorm.includes(matchNorm) ||
              varNames.includes(matchNorm) ||
              varSkus.includes(matchNorm);

            if (hit) {
              collected.push({
                gtin: doc.id,
                ...d,
                variations_list: vars,
              });

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

        return res.json({ rows: collected, locations: [], nextCursor });
      }

      // ---------- DOC-ID MODE ----------
      if (cursor && cursorMode === "docId") {
        const cursorDoc = await colRef.doc(cursor).get();
        if (cursorDoc.exists) query = query.startAfter(cursorDoc);
      }

      const snap = await query.get();

      // If GTIN exact search + onlyDuplicates, filter after fetch
      let docs = snap.docs;
      if (hasQuery && isDigits && qNoSpace.length >= 8 && onlyDuplicates) {
        docs = docs.filter((doc) => Number((doc.data() || {}).variation_count || 0) > 1);
      }

      const rows = docs.map((d) => {
        const data = d.data() || {};
        const vars = variationsToArray(data.variations);
        return { gtin: d.id, ...data, variations_list: vars };
      });

      let nextCursor = null;
      if (docs.length > 0) nextCursor = docs[docs.length - 1].id;

      res.json({ rows, locations: [], nextCursor });
    } catch (err) {
      console.error("Error in /api/gtin-matrix:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  return router;
};
