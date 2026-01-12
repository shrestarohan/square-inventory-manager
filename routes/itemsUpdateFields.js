// routes/itemsUpdateFields.js
// ------------------------------------------------------------
// POST /api/items/update-fields
// body: {
//   merchantId: "ML...",
//   itemId: "ITEM_ID",                // required (Square ITEM id)
//   variationId?: "ITEM_VARIATION_ID",// optional but recommended for sku/gtin/price updates
//   updates: {
//     item_name?: string,
//     sku?: string,
//     gtin?: string,   // we write to Square variation "upc" (digits only recommended)
//     price?: number   // dollars (e.g. 12.99) -> Square money.amount (cents)
//   }
// }
//
// Behavior:
// - Updates Square:
//   - item_name -> Catalog ITEM.itemData.name
//   - sku/gtin/price -> Catalog ITEM_VARIATION.itemVariationData.{sku, upc, priceMoney}
// - Updates Firestore (best-effort):
//   - merchants/{merchantId}/inventory: by item_id == itemId AND fallback variation_id == variationId
//   - global inventory: by item_id == itemId (and fallback by variation_id)
// ------------------------------------------------------------

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

function toCents(n) {
  const x = Number(n);
  if (!isFinite(x)) return null;
  return Math.round(x * 100);
}

function normalizeGtin(v) {
  const s = (v ?? "").toString().trim().replace(/\s+/g, "");
  if (!s) return ""; // allow clear
  if (!/^\d+$/.test(s)) throw new Error("GTIN must be digits only.");
  if (s.length < 8 || s.length > 20) throw new Error("GTIN length looks invalid (expected 8–20 digits).");
  return s;
}

function normalizeSku(v) {
  // SKU can be any string; trim only
  return (v ?? "").toString().trim();
}

function normalizeItemName(v) {
  const s = (v ?? "").toString().trim();
  if (!s) throw new Error("Item name cannot be empty.");
  return s;
}

module.exports = function buildItemsUpdateFieldsRouter({ firestore, requireLogin }) {
  const router = express.Router();
  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  router.post("/api/items/update-fields", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.body?.merchantId || "").toString().trim();
      const itemId = (req.body?.itemId || "").toString().trim();
      const variationId = (req.body?.variationId || "").toString().trim() || null;
      const updatesIn = req.body?.updates || {};

      if (!merchantId) return res.status(400).json({ success: false, error: "Missing merchantId" });
      if (!itemId) return res.status(400).json({ success: false, error: "Missing itemId" });
      if (!updatesIn || typeof updatesIn !== "object") {
        return res.status(400).json({ success: false, error: "Missing updates object" });
      }

      const want = {
        item_name: Object.prototype.hasOwnProperty.call(updatesIn, "item_name"),
        sku: Object.prototype.hasOwnProperty.call(updatesIn, "sku"),
        gtin: Object.prototype.hasOwnProperty.call(updatesIn, "gtin"),
        price: Object.prototype.hasOwnProperty.call(updatesIn, "price"),
      };

      if (!want.item_name && !want.sku && !want.gtin && !want.price) {
        return res.status(400).json({ success: false, error: "No supported fields in updates" });
      }

      // Validate + normalize input
      const updates = {};
      if (want.item_name) updates.item_name = normalizeItemName(updatesIn.item_name);
      if (want.sku) updates.sku = normalizeSku(updatesIn.sku);
      if (want.gtin) updates.gtin = normalizeGtin(updatesIn.gtin);
      if (want.price) {
        const cents = toCents(updatesIn.price);
        if (cents === null) return res.status(400).json({ success: false, error: "Price must be a number" });
        if (cents < 0) return res.status(400).json({ success: false, error: "Price cannot be negative" });
        updates.price = Number(updatesIn.price);
        updates.price_cents = cents;
      }

      const squareClient = await createSquareClientForMerchant({ merchantId });
      const catalogApi = squareClient.catalogApi;

      // -----------------------------
      // Square updates
      // -----------------------------
      let squareItemUpdated = false;
      let squareVariationUpdated = false;

      // We'll return what we actually applied
      const applied = {};

      // 1) Update ITEM name if requested
      if (want.item_name) {
        const itemResp = await catalogApi.retrieveCatalogObject(itemId, false);
        const itemObj = itemResp?.result?.object;

        if (!itemObj || itemObj.type !== "ITEM") {
          return res.status(404).json({ success: false, error: `Square ITEM not found: ${itemId}` });
        }

        const version = jsonSafe(itemObj.version);
        const itemData = itemObj.itemData || {};

        const upsertBody = {
          idempotencyKey: `item-name-${merchantId}-${itemId}-${Date.now()}`,
          object: {
            id: itemId,
            type: "ITEM",
            version,
            itemData: {
              ...itemData,
              name: updates.item_name,
            },
          },
        };

        const upsertResp = await catalogApi.upsertCatalogObject(upsertBody);
        const sqErrs = pickSquareErrors(upsertResp?.result);
        if (sqErrs) {
          return res.status(400).json({
            success: false,
            error: "Square upsert (ITEM) returned errors",
            squareErrors: sqErrs,
          });
        }

        squareItemUpdated = true;
        applied.item_name = updates.item_name;
      }

      // 2) Update VARIATION fields (sku/gtin/price) if requested
      if (want.sku || want.gtin || want.price) {
        if (!variationId) {
          return res.status(400).json({
            success: false,
            error: "variationId is required to update sku/gtin/price",
          });
        }

        const varResp = await catalogApi.retrieveCatalogObject(variationId, false);
        const varObj = varResp?.result?.object;

        if (!varObj || varObj.type !== "ITEM_VARIATION") {
          return res.status(404).json({ success: false, error: `Square VARIATION not found: ${variationId}` });
        }

        const version = jsonSafe(varObj.version);
        const vData = varObj.itemVariationData || {};

        // Preserve existing priceMoney currency unless you override
        const existingPriceMoney = vData.priceMoney || null;
        const currency = existingPriceMoney?.currency || "USD";

        const nextVariationData = { ...vData };

        if (want.sku) nextVariationData.sku = updates.sku || "";
        // Square uses `upc` on variation for GTIN/UPC/EAN
        if (want.gtin) nextVariationData.upc = updates.gtin || "";

        if (want.price) {
          nextVariationData.priceMoney = {
            amount: updates.price_cents, // integer cents
            currency,
          };
        }

        const upsertBody = {
          idempotencyKey: `var-fields-${merchantId}-${variationId}-${Date.now()}`,
          object: {
            id: variationId,
            type: "ITEM_VARIATION",
            version,
            itemVariationData: nextVariationData,
          },
        };

        const upsertResp = await catalogApi.upsertCatalogObject(upsertBody);
        const sqErrs = pickSquareErrors(upsertResp?.result);
        if (sqErrs) {
          return res.status(400).json({
            success: false,
            error: "Square upsert (VARIATION) returned errors",
            squareErrors: sqErrs,
          });
        }

        squareVariationUpdated = true;
        if (want.sku) applied.sku = updates.sku;
        if (want.gtin) applied.gtin = updates.gtin;
        if (want.price) applied.price = updates.price;
      }

      // -----------------------------
      // Firestore updates (best-effort)
      // -----------------------------
      const actor = req.user?.email || req.user?.id || "unknown";
      const ts = nowIso();

      const patch = {
        updated_at: ts,
        last_action: "update_fields",
        last_action_at: ts,
        last_action_by: actor,
      };

      // Maintain your derived fields if present
      if (want.item_name) {
        patch.item_name = applied.item_name;
        patch.item_name_lc = applied.item_name.toLowerCase();
      }
      if (want.sku) {
        patch.sku = applied.sku;
      }
      if (want.gtin) {
        patch.gtin = applied.gtin;
      }
      if (want.price) {
        patch.price = applied.price;
      }

      let updatedMerchantInventoryDocs = 0;
      let updatedGlobalInventoryDocs = 0;

      // merchants/{merchantId}/inventory
      try {
        const invRef = firestore.collection("merchants").doc(merchantId).collection("inventory");

        const byItem = await invRef.where("item_id", "==", itemId).get();
        const byVar = variationId ? await invRef.where("variation_id", "==", variationId).get() : { docs: [] };

        const seen = new Set();
        const batch = firestore.batch();

        for (const d of [...byItem.docs, ...byVar.docs]) {
          if (seen.has(d.ref.path)) continue;
          seen.add(d.ref.path);
          batch.set(d.ref, patch, { merge: true });
        }

        if (seen.size) {
          await batch.commit();
          updatedMerchantInventoryDocs = seen.size;
        }
      } catch (e) {
        console.warn("Firestore merchant inventory update warning:", e?.message || e);
      }

      // global inventory (if you use it)
      try {
        const globalRef = firestore.collection("inventory");
        const gByItem = await globalRef.where("item_id", "==", itemId).get();
        const gByVar = variationId ? await globalRef.where("variation_id", "==", variationId).get() : { docs: [] };

        const seen = new Set();
        const batch = firestore.batch();

        for (const d of [...gByItem.docs, ...gByVar.docs]) {
          if (seen.has(d.ref.path)) continue;
          seen.add(d.ref.path);
          batch.set(d.ref, patch, { merge: true });
        }

        if (seen.size) {
          await batch.commit();
          updatedGlobalInventoryDocs = seen.size;
        }
      } catch (e) {
        console.warn("Firestore global inventory update warning:", e?.message || e);
      }

      return res.json({
        success: true,
        merchantId,
        itemId,
        variationId: variationId || null,
        updated: applied, // what we applied/normalized
        square: {
          itemUpdated: squareItemUpdated,
          variationUpdated: squareVariationUpdated,
        },
        firestore: {
          updatedMerchantInventoryDocs,
          updatedGlobalInventoryDocs,
        },
      });
    } catch (err) {
      console.error("Error in POST /api/items/update-fields:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
