const express = require("express");
const router = express.Router();

function normKey(name) {
  return (name || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");
}

module.exports = function buildCategoryMatrixRouter({ firestore, requireLogin }) {
  router.get("/api/category-matrix", requireLogin, async (req, res) => {
    try {
      const qRaw = (req.query.q || "").toString().trim().toLowerCase();
      const q = qRaw ? normKey(qRaw) : "";

      // Pull merchants (to define columns)
      const mSnap = await firestore.collection("merchants").get();
      const merchants = mSnap.docs.map(d => ({
        id: d.id,
        name: d.data()?.business_name || d.id,
      }));

      // Pull all categories (top-level collection)
      const cSnap = await firestore.collection("square_categories").get();
      const all = cSnap.docs
        .map(d => d.data())
        .filter(x => x && !x.is_deleted);

      // Group by normalized name
      const rowsByKey = new Map();

      for (const c of all) {
        const key = normKey(c.category_name);
        if (!key) continue;

        if (q && !key.includes(q)) continue;

        if (!rowsByKey.has(key)) {
          rowsByKey.set(key, {
            category_key: key,
            canonical_name: c.category_name || "",
            byMerchant: {}, // merchantId -> { category_id, category_name }
          });
        }

        const row = rowsByKey.get(key);

        // Choose a nicer canonical name if current is longer/more complete
        if ((c.category_name || "").length > (row.canonical_name || "").length) {
          row.canonical_name = c.category_name || row.canonical_name;
        }

        row.byMerchant[c.merchant_id] = {
          category_id: c.category_id,
          category_name: c.category_name,
          fetched_at: c.fetched_at || null,
        };
      }

      // Convert to array and compute missing/mismatch flags
      const rows = Array.from(rowsByKey.values()).map(r => {
        const presentCount = merchants.reduce((acc, m) => acc + (r.byMerchant[m.id] ? 1 : 0), 0);
        const missingCount = merchants.length - presentCount;

        // name mismatch if merchants have different names for the same normalized key
        const names = merchants
          .map(m => r.byMerchant[m.id]?.category_name)
          .filter(Boolean)
          .map(s => s.toLowerCase().trim());
        const nameMismatch = new Set(names).size > 1;

        return {
          ...r,
          presentCount,
          missingCount,
          nameMismatch,
        };
      });

      // Sort: missing first, then name mismatches, then name
      rows.sort((a, b) => {
        if (b.missingCount !== a.missingCount) return b.missingCount - a.missingCount;
        if (Number(b.nameMismatch) !== Number(a.nameMismatch)) return Number(b.nameMismatch) - Number(a.nameMismatch);
        return (a.canonical_name || "").localeCompare(b.canonical_name || "");
      });

      res.json({ merchants, rows });
    } catch (err) {
      console.error("Error in /api/category-matrix:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  return router;
};
