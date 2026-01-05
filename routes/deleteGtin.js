// routes/deleteGtin.js
const express = require("express");
const router = express.Router();
const { FieldValue } = require("@google-cloud/firestore");

const { canonicalGtin, normalizeDigits } = require("../lib/gtin");

module.exports = function buildDeleteGtinRouter({ requireLogin, firestore, createSquareClient }) {
  if (typeof createSquareClient !== "function") {
    throw new Error("createSquareClient must be passed into buildDeleteGtinRouter()");
  }

  // ----- Helpers -----

  function now() {
    return new Date().toISOString();
  }

  function log(...args) {
    console.log(`[delete-item ${now()}]`, ...args);
  }

  function logErr(...args) {
    console.error(`[delete-item ${now()}]`, ...args);
  }

  function summarizeSquareError(e) {
    // Square SDK errors often include: e.errors, e.statusCode, e.body, e.result, e.response
    const out = {
      message: e?.message,
      statusCode: e?.statusCode,
      errors: e?.errors || e?.body?.errors || e?.result?.errors,
      body: e?.body,
    };
    // avoid giant circular refs
    return out;
  }

  // Helper: delete merchant inventory docs by GTIN in safe batches
  async function deleteMerchantInventoryByGtin(merchantId, gtin) {
    const invCol = firestore.collection("merchants").doc(merchantId).collection("inventory");
    let deleted = 0;
    let loops = 0;

    while (true) {
      loops++;
      const snap = await invCol.where("gtin", "==", gtin).limit(450).get();
      if (snap.empty) break;

      const b = firestore.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();

      deleted += snap.size;
      if (snap.size < 450) break;
      if (loops > 50) {
        logErr("⚠️ deleteMerchantInventoryByGtin loop protection hit", { merchantId, gtin, deleted, loops });
        break;
      }
    }

    log("FS deleted merchants/{mid}/inventory", { merchantId, gtin, deleted });
    return deleted;
  }

  async function deleteGlobalInventoryByGtinAndMerchant(gtin, merchantId) {
    const invCol = firestore.collection("inventory");
    let deleted = 0;
    let loops = 0;

    while (true) {
      loops++;
      const snap = await invCol
        .where("gtin", "==", gtin)
        .where("merchant_id", "==", merchantId)
        .limit(450)
        .get();

      if (snap.empty) break;

      const b = firestore.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();

      deleted += snap.size;
      if (snap.size < 450) break;
      if (loops > 50) {
        logErr("⚠️ deleteGlobalInventoryByGtinAndMerchant loop protection hit", { merchantId, gtin, deleted, loops });
        break;
      }
    }

    log("FS deleted inventory (global) by gtin+merchant", { merchantId, gtin, deleted });
    return deleted;
  }

  // Fix: also delete from the global inventory collection by GTIN
  async function deleteGlobalInventoryByGtin(gtin) {
    const invCol = firestore.collection("inventory");
    let deleted = 0;
    let loops = 0;

    while (true) {
      loops++;
      const snap = await invCol.where("gtin", "==", gtin).limit(450).get();
      if (snap.empty) break;

      const b = firestore.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();

      deleted += snap.size;
      if (snap.size < 450) break;
      if (loops > 50) {
        logErr("⚠️ deleteGlobalInventoryByGtin loop protection hit", { gtin, deleted, loops });
        break;
      }
    }

    log("FS deleted inventory (global) by gtin", { gtin, deleted });
    return deleted;
  }

  // Helper: delete/archive in Square with logs
  async function archiveOrDeleteInSquare(square, merchantId, { variationIds, itemIds }) {
    const ids = [...(variationIds || []), ...(itemIds || [])].filter(Boolean);
    if (!ids.length) return { attempted: 0, ok: 0, failed: 0 };

    if (!square?.catalogApi?.deleteCatalogObject) {
      console.error("Square client missing catalogApi.deleteCatalogObject", {
        merchantId,
        squareKeys: square ? Object.keys(square) : null,
        catalogApiKeys: square?.catalogApi ? Object.keys(square.catalogApi) : null,
      });
      return { attempted: ids.length, ok: 0, failed: ids.length, error: "catalogApi.deleteCatalogObject missing" };
    }

    let ok = 0, failed = 0;

    for (const objectId of ids) {
      try {
        console.log("[Square] deleting", { merchantId, objectId });
        const resp = await square.catalogApi.deleteCatalogObject(objectId);
        ok++;
        console.log("[Square] delete OK", { merchantId, objectId, status: resp?.statusCode });
      } catch (e) {
        failed++;
        console.error("[Square] delete FAILED", {
          merchantId,
          objectId,
          message: e?.message,
          statusCode: e?.statusCode,
          // legacy SDK often has result.errors
          errors: e?.result?.errors || e?.errors || e?.body?.errors,
        });
      }
    }

    return { attempted: ids.length, ok, failed };
  }


  // ----- Route -----

  router.post("/delete-item", requireLogin, async (req, res) => {
    log("hit /api/delete-item");

    try {
      const gtin = canonicalGtin(req.body?.gtin || "");
      const merchantIdParam = req.body?.merchantId ? String(req.body.merchantId).trim() : null;
      const variationIdParam = req.body?.variationId ? String(req.body.variationId).trim() : null;
      const itemIdParam = req.body?.itemId ? String(req.body.itemId).trim() : null;
      const mode = req.body?.mode ? String(req.body.mode).trim() : null;

      log("request body", { gtin, merchantIdParam, variationIdParam, itemIdParam, mode });

      if (!gtin) return res.status(400).json({ success: false, error: "gtin required" });

      // 1) Load consolidated doc to discover which merchants/ids exist
      const docRef = firestore.collection("gtin_inventory_matrix").doc(gtin);
      const snap = await docRef.get();

      log("gtin_inventory_matrix lookup", { gtin, exists: snap.exists });

      if (!snap.exists) {
        // still delete from inventories (dashboard/global) based on request params
        // helpful when consolidated doc is stale
        if (merchantIdParam) {
          await deleteMerchantInventoryByGtin(merchantIdParam, gtin);
          await deleteGlobalInventoryByGtinAndMerchant(gtin, merchantIdParam);
        } else {
          await deleteGlobalInventoryByGtin(gtin);
        }
        return res.json({ success: true, message: "Not found in gtin_inventory_matrix (deleted raw inventories only)." });
      }

      const data = snap.data() || {};
      const pricesByLocation = data.pricesByLocation || {};

      // Build merchant -> IDs map
      const byMerchant = new Map(); // merchantId -> { variationIds:Set, itemIds:Set, locKeys:Set }
      for (const [locKey, info] of Object.entries(pricesByLocation)) {
        const mid = info?.merchant_id;
        if (!mid) continue;
        if (merchantIdParam && mid !== merchantIdParam) continue;

        const entry = byMerchant.get(mid) || { variationIds: new Set(), itemIds: new Set(), locKeys: new Set() };
        if (info.variation_id) entry.variationIds.add(info.variation_id);
        if (info.item_id) entry.itemIds.add(info.item_id);
        entry.locKeys.add(locKey);
        byMerchant.set(mid, entry);
      }

      log("byMerchant built", {
        size: byMerchant.size,
        merchantIds: Array.from(byMerchant.keys()),
      });

      if (byMerchant.size === 0) {
        return res.json({
          success: true,
          message: merchantIdParam
            ? "GTIN not present for that merchant in consolidated doc."
            : "No merchant entries found in consolidated doc.",
        });
      }

      const results = [];

      // 2) For each targeted merchant: Firestore delete + Square delete/archive
      for (const [merchantId, ids] of byMerchant.entries()) {
        log("processing merchant", {
          merchantId,
          gtin,
          variationIdsCount: ids.variationIds.size,
          itemIdsCount: ids.itemIds.size,
          locKeysCount: ids.locKeys.size,
        });

        // 2a) Delete Firestore (global + merchant scoped)
        const delGlobal = await deleteGlobalInventoryByGtinAndMerchant(gtin, merchantId);
        const delMerchant = await deleteMerchantInventoryByGtin(merchantId, gtin);

        // delete merchant-level matrices too
        await firestore.collection("merchants").doc(merchantId).collection("gtin_matrix").doc(gtin).delete().catch((e) => {
          logErr("failed deleting merchants/{mid}/gtin_matrix", { merchantId, gtin, err: e?.message || e });
        });

        await firestore.collection("merchants").doc(merchantId).collection("gtin_inventory_matrix").doc(gtin).delete().catch((e) => {
          logErr("failed deleting merchants/{mid}/gtin_inventory_matrix", { merchantId, gtin, err: e?.message || e });
        });

        // 2b) Square delete (prefer request IDs if dashboard sent them and merchant matches)
        // This protects you if consolidated matrix is stale.
        const variationIds = new Set(Array.from(ids.variationIds));
        const itemIds = new Set(Array.from(ids.itemIds));

        if (merchantIdParam && merchantIdParam === merchantId) {
          if (variationIdParam) variationIds.add(variationIdParam);
          if (itemIdParam) itemIds.add(itemIdParam);
        }

        let squareDeleteSummary = null;
        try {
          log("creating square client", { merchantId });
          const square = await createSquareClient({ merchantId });
          squareDeleteSummary = await archiveOrDeleteInSquare(square, merchantId, {
            variationIds: Array.from(variationIds),
            itemIds: Array.from(itemIds),
          });
        } catch (e) {
          logErr("Square client/delete failure", { merchantId, err: summarizeSquareError(e) });
          squareDeleteSummary = { attempted: 0, ok: 0, failed: 0, error: e?.message || String(e) };
        }

        results.push({
          merchantId,
          fsDeleted: { global: delGlobal, merchant: delMerchant },
          square: squareDeleteSummary,
        });
      }

      // 2c) If mismatch page (no merchantId), also wipe global inventory by GTIN (all merchants)
      if (!merchantIdParam) {
        await deleteGlobalInventoryByGtin(gtin);
      }

      // 3) Update or delete consolidated doc
      if (merchantIdParam) {

        const update = {};
        for (const [, ids] of byMerchant.entries()) {
          for (const locKey of ids.locKeys) {
            update[`pricesByLocation.${locKey}`] = FieldValue.delete();
          }
        }

        log("updating consolidated doc to remove locKeys", {
          gtin,
          removeKeys: Object.keys(update).length,
        });

        await docRef.update(update);

        const after = await docRef.get();
        const remaining = after.exists && after.data()?.pricesByLocation
          ? Object.keys(after.data().pricesByLocation).length
          : 0;

        log("post-update consolidated remaining", { gtin, remaining });

        if (remaining === 0) {
          await docRef.delete();
          log("deleted consolidated doc (empty)", { gtin });
        }
      } else {
        await docRef.delete();
        log("deleted consolidated doc (full delete)", { gtin });
      }

      return res.json({ success: true, results });
    } catch (err) {
      logErr("delete-item failed (top-level)", { err: err?.message || err, stack: err?.stack });
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
