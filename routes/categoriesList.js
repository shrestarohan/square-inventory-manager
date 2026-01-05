// routes/categoriesList.js
const express = require("express");

module.exports = function buildCategoriesListRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // GET /api/categories?merchantId=...
  router.get("/api/categories", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.query.merchantId || "").toString().trim();
      if (!merchantId) return res.status(400).json({ success: false, error: "Missing merchantId" });

      const snap = await firestore.collection("square_categories")
        .where("merchant_id", "==", merchantId)
        .get();

      const categories = snap.docs
        .map(d => d.data() || {})
        .filter(c => c.category_id && c.category_name)
        .map(c => ({ categoryId: c.category_id, name: c.category_name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.json({ success: true, categories });
    } catch (err) {
      console.error("Error in GET /api/categories:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
