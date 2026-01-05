// routes/replenishment.js
const express = require("express");

module.exports = function buildReplenishmentRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // GET /api/replenishment?merchantId=ML...&onlyNeedsReorder=1&limit=200
  router.get("/api/replenishment", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.query.merchantId || "").toString().trim();
      if (!merchantId) return res.status(400).json({ success: false, error: "Missing merchantId" });

      const onlyNeedsReorder =
        req.query.onlyNeedsReorder === "1" ||
        req.query.onlyNeedsReorder === "true" ||
        req.query.onlyNeedsReorder === true;

      const limit = Math.min(Number(req.query.limit) || 200, 1000);

      let q = firestore.collection("merchants").doc(merchantId).collection("replenishment_recommendations");

      // Firestore can’t do computed comparisons easily; simplest: pull and filter.
      const snap = await q.limit(limit).get();

      let rows = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

      if (onlyNeedsReorder) {
        // needs reorder if on_hand exists and below ROP, OR roq > 0
        rows = rows.filter(r => (Number(r.roq || 0) > 0) || (r.on_hand !== null && r.on_hand !== undefined && Number(r.on_hand) < Number(r.rop || 0)));
      }

      // sort by biggest suggested order qty first
      rows.sort((a,b) => Number(b.roq || 0) - Number(a.roq || 0));

      return res.json({ success: true, merchantId, rows });
    } catch (e) {
      console.error("GET /api/replenishment error:", e);
      return res.status(500).json({ success: false, error: e.message || "Internal error" });
    }
  });

  return router;
};
