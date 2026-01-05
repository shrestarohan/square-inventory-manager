// routes/categoriesRename.js
// ------------------------------------------------------------
// POST /api/categories/rename
// body: { merchantId, categoryId, newName }
// Updates:
//   1) Square Catalog CATEGORY name (for that merchant)
//   2) Firestore square_categories doc: <merchantId>__<categoryId>
// ------------------------------------------------------------

const express = require("express");
const router = express.Router();

const { makeCreateSquareClientForMerchant } = require("../lib/square");

function nowIso() {
  return new Date().toISOString();
}

function idempotencyKey(prefix, ...parts) {
  const raw = [prefix, ...parts].join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${prefix}-${h.toString(16)}`;
}

function jsonSafe(v) {
  return typeof v === "bigint" ? v.toString() : v;
}

function deepJsonSafe(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
}

module.exports = function buildCategoriesRenameRouter({ requireLogin, firestore }) {
  if (!firestore) throw new Error("categoriesRename router requires firestore");

  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  router.post("/api/categories/rename", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.body?.merchantId || "").toString().trim();
      const categoryId = (req.body?.categoryId || "").toString().trim();
      const newName = (req.body?.newName || "").toString().trim();

      if (!merchantId) return res.status(400).json({ success: false, error: "Missing merchantId" });
      if (!categoryId) return res.status(400).json({ success: false, error: "Missing categoryId" });
      if (!newName) return res.status(400).json({ success: false, error: "Missing newName" });

      // ✅ Create Square client (IMPORTANT: pass { merchantId } not just string)
      const squareClient = await createSquareClientForMerchant({ merchantId });
      const catalogApi = squareClient.catalogApi;

      // 1) Retrieve current category (gets latest version)
      const retrieveResp = await catalogApi.retrieveCatalogObject(categoryId, false);
      const catObj = retrieveResp?.result?.object;

      if (!catObj || catObj.type !== "CATEGORY") {
        return res.status(404).json({
          success: false,
          error: `Square category not found or not CATEGORY: ${categoryId}`,
        });
      }

      const version = jsonSafe(catObj.version);          
      if (version == null) {
        return res.status(500).json({
          success: false,
          error: "Square category missing version (unexpected)",
        });
      }

      // 2) Update name in Square
      const upsertBody = {
        idempotencyKey: idempotencyKey("cat-rename", merchantId, categoryId, newName),
        object: {
          id: categoryId,
          type: "CATEGORY",
          version,
          categoryData: {
            name: newName,
          },
        },
      };

      const upsertResp = await catalogApi.upsertCatalogObject(upsertBody);
      const updatedObj = upsertResp?.result?.catalogObject;

      const updatedVersion = jsonSafe(updatedObj?.version ?? null);
      const updatedName = updatedObj?.categoryData?.name ?? newName;

      // 3) Update Firestore square_categories
      const docId = `${merchantId}__${categoryId}`;
      const ref = firestore.collection("square_categories").doc(docId);

      await ref.set(
        deepJsonSafe({
            merchant_id: merchantId,
            category_id: categoryId,
            category_name: updatedName,
            version: updatedVersion,
            updated_at: nowIso(),
            fetched_at: nowIso(),
            last_action: "rename",
            last_action_at: nowIso(),
            last_action_by: req.user?.email || req.user?.id || "unknown",
        }),
        { merge: true }
      );

      // Optional audit trail
      await firestore.collection("audit_logs").add({
        type: "CATEGORY_RENAME",
        merchant_id: merchantId,
        category_id: categoryId,
        new_name: updatedName,
        old_name: catObj?.categoryData?.name || null,
        ts: nowIso(),
        actor: req.user?.email || null,
      });


      return res.json(
        deepJsonSafe({
            success: true,
            merchantId,
            categoryId,
            categoryName: updatedName,
            version: updatedVersion,
        })
      );
    } catch (err) {
      console.error("Error in POST /api/categories/rename:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
