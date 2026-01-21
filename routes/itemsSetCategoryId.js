// routes/itemsSetCategoryId.js
const express = require("express");
const { makeCreateSquareClientForMerchant } = require("../lib/square");

function nowIso() {
  return new Date().toISOString();
}

function jsonSafe(v) {
  return typeof v === "bigint" ? v.toString() : v;
}

function pickSquareErrors(result) {
  const errs = result?.errors;
  if (Array.isArray(errs) && errs.length) return errs;
  return null;
}

module.exports = function buildItemsSetCategoryIdRouter({ firestore, requireLogin }) {
  const router = express.Router();
  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  // POST /api/items/set-category-id
  // body: { merchantId, itemId, categoryId, categoryName? }
  //
  // - itemId can be ITEM or ITEM_VARIATION (we resolve parent ITEM)
  // - Updates Square ITEM.itemData.categories = [{ id: categoryId }]
  // - Optionally sets Reporting Category too (Square field may be reportingCategory or reporting_category)
  // - Updates Firestore merchants/{merchantId}/inventory:
  //     - by item_id == targetItemId (updates all variations if you store item_id on each doc)
  //     - PLUS fallback by variation_id == itemIdRaw (in case your docs are keyed by variation)
  //
  // Response is BigInt-safe (strings only)
  router.post("/api/items/set-category-id", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.body?.merchantId || "").toString().trim();
      const itemIdRaw = (req.body?.itemId || "").toString().trim();
      const categoryId = (req.body?.categoryId || "").toString().trim();

      // optional: client can send the selected category text so we can persist it even if lookup misses
      const categoryNameFromClient = (req.body?.categoryName || "").toString().trim() || null;

      if (!merchantId) return res.status(400).json({ success: false, error: "Missing merchantId" });
      if (!itemIdRaw) return res.status(400).json({ success: false, error: "Missing itemId" });
      if (!categoryId) return res.status(400).json({ success: false, error: "Missing categoryId" });

      // Optional: category name for UI/Firestore (prefer Firestore lookup, fallback to client-provided)
      let categoryName = categoryNameFromClient;
      try {
        const catSnap = await firestore
          .collection("square_categories")
          .where("merchant_id", "==", merchantId)
          .where("category_id", "==", categoryId)
          .limit(1)
          .get();
        if (!catSnap.empty) categoryName = catSnap.docs[0].data()?.category_name || categoryName;
      } catch {
        // ignore
      }

      const squareClient = await createSquareClientForMerchant({ merchantId });
      const catalogApi = squareClient.catalogApi;

      // 1) Retrieve the ID we were given (ITEM or ITEM_VARIATION)
      const retrieveResp = await catalogApi.retrieveCatalogObject(itemIdRaw, false);
      const obj = retrieveResp?.result?.object;

      if (!obj) {
        return res.status(404).json({ success: false, error: `Square object not found: ${itemIdRaw}` });
      }

      // 2) Resolve to ITEM id
      let targetItemId = itemIdRaw;
      if (obj.type === "ITEM_VARIATION") {
        const parentItemId = obj?.itemVariationData?.itemId;
        if (!parentItemId) {
          return res.status(400).json({
            success: false,
            error: "Provided ITEM_VARIATION missing itemVariationData.itemId",
          });
        }
        targetItemId = parentItemId;
      } else if (obj.type !== "ITEM") {
        return res.status(400).json({
          success: false,
          error: `Expected ITEM or ITEM_VARIATION id, got type=${obj.type}`,
        });
      }

      // 3) Retrieve latest ITEM (if we resolved from variation)
      const itemResp =
        targetItemId === itemIdRaw
          ? retrieveResp
          : await catalogApi.retrieveCatalogObject(targetItemId, false);

      const itemObj = itemResp?.result?.object;
      if (!itemObj || itemObj.type !== "ITEM") {
        return res.status(404).json({ success: false, error: `Square ITEM not found: ${targetItemId}` });
      }

      const version = jsonSafe(itemObj.version); // string-safe
      const itemData = itemObj.itemData || {};

      // 4) Upsert ITEM with categories + (optional) reporting category
      // Categories in Square are set on itemData.categories.
      // Reporting category is separate; different SDKs may accept reportingCategory or reporting_category.
      const upsertBody = {
        idempotencyKey: `item-setcats-${merchantId}-${targetItemId}-${categoryId}-${Date.now()}`,
        object: {
          id: targetItemId,
          type: "ITEM",
          version,
          itemData: {
            ...itemData,
            categories: [{ id: categoryId }],

            // Try to set Reporting Category too:
            // If your SDK ignores one, the other may work depending on serialization.
            reportingCategory: { id: categoryId, ordinal: 0 },
            reporting_category: { id: categoryId, ordinal: 0 },
          },
        },
      };

      const upsertResp = await catalogApi.upsertCatalogObject(upsertBody);

      const sqErrs = pickSquareErrors(upsertResp?.result);
      if (sqErrs) {
        return res.status(400).json({
          success: false,
          error: "Square upsert returned errors",
          squareErrors: sqErrs,
          debug: { merchantId, itemIdRaw, targetItemId, categoryId },
        });
      }

      const updatedObj = upsertResp?.result?.catalogObject || null;
      const updatedVersion = String(jsonSafe(updatedObj?.version ?? "")); // ensure string

      // 5) Verify in Square (BigInt-safe: only strings)
      let categoryIdsInSquare = [];
      let reportingCategoryIdInSquare = null;

      try {
        const verify = await catalogApi.retrieveCatalogObject(targetItemId, false);

        const cats = verify?.result?.object?.itemData?.categories || [];
        categoryIdsInSquare = Array.isArray(cats) ? cats.map((c) => c?.id).filter(Boolean) : [];

        const rc =
          verify?.result?.object?.itemData?.reportingCategory ||
          verify?.result?.object?.itemData?.reporting_category ||
          null;

        reportingCategoryIdInSquare = rc?.id || null;
      } catch {
        // ignore verify failures
      }

      // 6) Update Firestore merchant inventory docs (best-effort)
      // Fix for "doesn't retain on reload": update by item_id AND fallback by variation_id.
      let updatedInventoryDocs = 0;

      try {
        const invRef = firestore.collection("merchants").doc(merchantId).collection("inventory");

        // Primary: update all docs for the ITEM (covers all variations if docs store item_id)
        const byItem = await invRef.where("item_id", "==", targetItemId).get();

        // Fallback: if docs don’t store item_id reliably, update doc(s) by variation_id
        // (only helps if the caller sent a variation id as itemIdRaw)
        const byVar = await invRef.where("variation_id", "==", itemIdRaw).get();

        const seen = new Set();
        const batch = firestore.batch();

        const writePatch = {
          category_id: categoryId,
          category_name: categoryName,
          // Optional: store reporting category too
          reporting_category_id: categoryId,
          reporting_category_name: categoryName,
          updated_at: nowIso(),
          last_action: "set_category",
          last_action_at: nowIso(),
          last_action_by: req.user?.email || req.user?.id || "unknown",
        };

        for (const d of [...byItem.docs, ...byVar.docs]) {
          if (seen.has(d.ref.path)) continue;
          seen.add(d.ref.path);
          batch.set(d.ref, writePatch, { merge: true });
        }

        if (seen.size) {
          await batch.commit();
          updatedInventoryDocs = seen.size;
        }
      } catch (e) {
        console.warn("Firestore update warning in /api/items/set-category-id:", e?.message || e);
      }

      // Also update global inventory (best-effort)
      try {
        const globalRef = firestore.collection("inventory");
        const globalSnap = await globalRef.where("item_id", "==", targetItemId).get();

        const batch2 = firestore.batch();
        globalSnap.docs.forEach(d => {
          batch2.set(d.ref, {
            category_id: categoryId,
            category_name: categoryName,
            updated_at: nowIso(),
            last_action: "set_category",
            last_action_at: nowIso(),
            last_action_by: req.user?.email || req.user?.id || "unknown",
          }, { merge: true });
        });

        if (!globalSnap.empty) await batch2.commit();
      } catch (e) {
        console.warn("Global inventory update warning:", e?.message || e);
      }


      return res.json({
        success: true,
        merchantId,
        itemIdRaw,
        targetItemId,
        categoryId,
        categoryName,
        categoryIdsInSquare,
        reportingCategoryIdInSquare,
        version: updatedVersion,
        updatedInventoryDocs,
      });
    } catch (err) {
      console.error("Error in POST /api/items/set-category-id:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
