// routes/debugFirestoreInv.js
const express = require("express");
const router = express.Router();
const firestore = require("../lib/firestore");

// GET /api/debug/find-inv-by-square-ids?merchantId=...&itemId=...&variationId=...
router.get("/api/debug/find-inv-by-square-ids", async (req, res) => {
  const merchantId = (req.query.merchantId || "").toString().trim();
  const itemId = (req.query.itemId || "").toString().trim();
  const variationId = (req.query.variationId || "").toString().trim();

  if (!merchantId) return res.status(400).json({ ok: false, error: "Missing merchantId" });
  if (!itemId && !variationId) return res.status(400).json({ ok: false, error: "Need itemId or variationId" });

  const inv = firestore.collection("merchants").doc(merchantId).collection("inventory");

  const out = {
    byDocId: null,
    byVariation: [],
    byItem: [],
    byUpc: [],
  };

  // 1) check docId = upc (sometimes you store by upc instead of gtin)
  if (req.query.docId) {
    const d = await inv.doc(req.query.docId.toString()).get();
    out.byDocId = d.exists ? { id: d.id, data: d.data() } : null;
  }

  // 2) variation_id search
  if (variationId) {
    const s = await inv.where("variation_id", "==", variationId).limit(5).get();
    out.byVariation = s.docs.map(d => ({ id: d.id, data: d.data() }));
  }

  // 3) item_id search
  if (itemId) {
    const s = await inv.where("item_id", "==", itemId).limit(5).get();
    out.byItem = s.docs.map(d => ({ id: d.id, data: d.data() }));
  }

  // 4) UPC/GTIN field search (in case docId != gtin)
  const upc = (req.query.upc || "").toString().trim();
  if (upc) {
    const s = await inv.where("upc", "==", upc).limit(5).get().catch(() => ({ docs: [] }));
    out.byUpc = (s.docs || []).map(d => ({ id: d.id, data: d.data() }));
  }

  res.json({ ok: true, merchantId, itemId, variationId, out });
});

module.exports = router;
