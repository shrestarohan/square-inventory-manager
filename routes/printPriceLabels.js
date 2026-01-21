const express = require("express");
const router = express.Router();

module.exports = function buildPrintPriceLabelsRouter({ firestore, requireLogin }) {
  router.get("/print/price-labels", requireLogin, async (req, res) => {
    try {
      const gtinsParam = (req.query.gtins || "").toString().trim();
      const locKey = (req.query.locKey || "").toString().trim(); // optional

      const gtins = gtinsParam.split(",").map(s => s.trim()).filter(Boolean);
      if (!gtins.length) return res.status(400).send("No GTINs provided.");

      const col = firestore.collection("gtin_inventory_matrix"); // adjust if different

      // Firestore "in" max 30
      const chunks = [];
      for (let i = 0; i < gtins.length; i += 30) chunks.push(gtins.slice(i, i + 30));

      const rows = [];
      for (const chunk of chunks) {
        const snap = await col.where("gtin", "in", chunk).get();
        snap.forEach(doc => rows.push(doc.data() || { gtin: doc.id }));
      }

      // Keep requested order
      const order = new Map(gtins.map((g, i) => [g, i]));
      rows.sort((a, b) => (order.get(a.gtin) ?? 999999) - (order.get(b.gtin) ?? 999999));

      // Build labels
      const labels = rows.map(r => {
        const pricesByLocation = r.pricesByLocation || {};
        let chosenPrice = null;

        if (locKey && pricesByLocation[locKey] && typeof pricesByLocation[locKey].price === "number") {
          chosenPrice = pricesByLocation[locKey].price;
        } else {
          // fallback: first available numeric price
          for (const k of Object.keys(pricesByLocation)) {
            const p = pricesByLocation[k]?.price;
            if (typeof p === "number" && Number.isFinite(p)) { chosenPrice = p; break; }
          }
        }

        // compute mismatch "spread" for coloring
        const numericPrices = [];
        for (const k of Object.keys(pricesByLocation)) {
          const p = pricesByLocation[k]?.price;
          if (typeof p === "number" && Number.isFinite(p)) numericPrices.push(p);
        }
        const minP = numericPrices.length ? Math.min(...numericPrices) : null;
        const maxP = numericPrices.length ? Math.max(...numericPrices) : null;
        const spread = (minP != null && maxP != null) ? (maxP - minP) : 0;

        return {
          gtin: r.gtin || "",
          item_name: r.item_name || "",
          image_url: r.image_url || r.image || r.imageUrl || "",
          price: chosenPrice,
          spread,
        };
      });

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      res.render("print/price-labels", { labels, locKey, baseUrl });
    } catch (err) {
      console.error("print labels error:", err);
      res.status(500).send("Failed to render labels.");
    }
  });

  return router;
};
