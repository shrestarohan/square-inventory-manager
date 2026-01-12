const express = require("express");
const router = express.Router();

module.exports = function buildSquareCategoriesRouter({ firestore, requireLogin }) {
  router.get("/api/square-categories", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.query.merchantId || "").trim();
      const q = (req.query.q || "").toLowerCase();

      if (!merchantId) {
        return res.status(400).json({ error: "merchantId required" });
      }

      let query = firestore
        .collection("square_categories")
        .where("merchant_id", "==", merchantId)
        .where("is_deleted", "==", false);

      const snap = await query.get();

      let rows = snap.docs.map(d => d.data());

      if (q) {
        rows = rows.filter(r =>
          (r.category_name || "").toLowerCase().includes(q)
        );
      }

      res.json({ rows });
    } catch (err) {
      console.error("square-categories error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
