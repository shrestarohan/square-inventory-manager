// routes/replenishmentAiPage.js
const express = require("express");

module.exports = function buildReplenishmentAiPageRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // GET /replenishment-ai/:merchantId?
  router.get("/replenishment-ai/:merchantId?", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.params.merchantId || "").toString().trim() || null;

      // Merchants for dropdown in header
      const merchantsSnap = await firestore.collection("merchants").get();
      const merchants = merchantsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

      // If no merchant selected, just render page
      res.render("replenishment-ai", {
        merchantId,
        merchants,
      });
    } catch (e) {
      console.error("Error rendering replenishment-ai:", e);
      res.status(500).send("Failed to render replenishment AI page.");
    }
  });

  return router;
};
