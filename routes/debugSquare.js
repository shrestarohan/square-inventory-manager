const express = require("express");
const router = express.Router();

const firestore = require("../lib/firestore");
const { makeCreateSquareClientForMerchant } = require("../lib/square");

async function squareFindByUpc(squareClient, upc) {
  const { result } = await squareClient.catalogApi.searchCatalogObjects({
    objectTypes: ["ITEM_VARIATION"],
    query: { exactQuery: { attributeName: "upc", attributeValue: upc } },
    includeRelatedObjects: true,
  });

  const vars = result?.objects || [];
  const rel = result?.relatedObjects || [];
  const v = vars[0];

  return {
    found: vars.length,
    variationId: v?.id || null,
    itemId: v?.itemVariationData?.itemId || null,
    variationUpc: v?.itemVariationData?.upc || null,
    itemName:
      rel.find((o) => o.type === "ITEM" && o.id === v?.itemVariationData?.itemId)?.itemData?.name || null,
  };
}

// GET /api/debug/square-find-by-upc?merchantId=...&upc=085676563868
router.get("/api/debug/square-find-by-upc", async (req, res) => {
  try {
    const merchantId = (req.query.merchantId || "").toString().trim();
    const upc = (req.query.upc || "").toString().trim();

    if (!merchantId) return res.status(400).json({ ok: false, error: "Missing merchantId" });
    if (!upc) return res.status(400).json({ ok: false, error: "Missing upc" });

    const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });
    const squareClient = await createSquareClientForMerchant({ merchantId });

    const out = await squareFindByUpc(squareClient, upc);
    return res.json({ ok: true, merchantId, upc, out });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
      square: e?.result?.errors || e?.errors || null,
    });
  }
});

module.exports = router;
