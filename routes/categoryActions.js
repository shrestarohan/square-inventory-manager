// routes/categoryActions.js
// ------------------------------------------------------------
// POST /api/categories/copy
//   Create category in destination merchant Square (if missing)
//   and upsert Firestore square_categories doc.
//
// POST /api/categories/delete-all
//   Delete category in Square for ALL merchants where present,
//   and mark Firestore square_categories docs as is_deleted=true.
//
// Requires:
// - Firestore collection: square_categories (merchantId__categoryId)
// - merchants collection used by lib/square.js factory
// - lib/square.js: makeCreateSquareClientForMerchant({ firestore })
// ------------------------------------------------------------

const express = require("express");
const router = express.Router();

function nowIso() {
  return new Date().toISOString();
}

function stableIdempotencyKey(prefix, ...parts) {
  const raw = [prefix, ...parts].join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${prefix}-${h.toString(16)}`;
}

async function getMerchantsList(firestore) {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
}

/**
 * Find a category doc for merchant by:
 * - category_id (fast)
 * - OR category_name (fallback)
 */
async function findCategoryForMerchant({ firestore, merchantId, categoryId, categoryName }) {
  let q = firestore.collection("square_categories").where("merchant_id", "==", merchantId);

  if (categoryId) {
    const snap = await q.where("category_id", "==", categoryId).limit(1).get();
    if (!snap.empty) return { ref: snap.docs[0].ref, data: snap.docs[0].data() };
  }

  if (categoryName) {
    const snap2 = await q.where("category_name", "==", categoryName).limit(1).get();
    if (!snap2.empty) return { ref: snap2.docs[0].ref, data: snap2.docs[0].data() };
  }

  return null;
}

async function upsertSquareCategory({ squareClient, categoryName }) {
  const catalogApi = squareClient.catalogApi;

  // Upsert creates if missing; we use temp id "#"
  const tempId = `#CAT_${Math.random().toString(16).slice(2)}`;

  const resp = await catalogApi.upsertCatalogObject({
    idempotencyKey: stableIdempotencyKey("cat-copy", categoryName),
    object: {
      type: "CATEGORY",
      id: tempId,
      categoryData: { name: categoryName },
    },
  });

  const obj = resp?.result?.catalogObject;
  const categoryId = obj?.id || null;

  if (!categoryId) throw new Error("Square upsert category failed: missing category id");

  return { categoryId, squareObject: obj };
}

async function deleteSquareCategory({ squareClient, categoryId }) {
  const catalogApi = squareClient.catalogApi;
  // Square deletes are idempotent-ish; if already deleted, Square may error.
  // We handle errors at caller per-merchant.
  const resp = await catalogApi.deleteCatalogObject(categoryId);
  return resp?.result || { ok: true };
}

module.exports = function buildCategoryActionsRouter({ firestore, requireLogin }) {
  // pull your square factory lazily so the file can be dropped in
  const { makeCreateSquareClientForMerchant } = require("../lib/square");
  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  // ------------------------------------------------------------
  // COPY CATEGORY to a merchant (Square + Firestore)
  // body:
  // {
  //   fromMerchantId,
  //   toMerchantId,
  //   categoryId,      // source category_id (optional but recommended)
  //   categoryName     // fallback
  // }
  // ------------------------------------------------------------
  router.post("/api/categories/copy", requireLogin, async (req, res) => {
    try {
      const fromMerchantId = (req.body?.fromMerchantId || "").toString().trim();
      const toMerchantId = (req.body?.toMerchantId || "").toString().trim();
      const categoryId = (req.body?.categoryId || "").toString().trim() || null;
      const categoryNameRaw = (req.body?.categoryName || "").toString().trim() || null;

      if (!fromMerchantId) return res.status(400).json({ success: false, error: "Missing fromMerchantId" });
      if (!toMerchantId) return res.status(400).json({ success: false, error: "Missing toMerchantId" });
      if (!categoryId && !categoryNameRaw) return res.status(400).json({ success: false, error: "Missing categoryId/categoryName" });

      // Confirm source exists in Firestore (to know correct name)
      const src = await findCategoryForMerchant({
        firestore,
        merchantId: fromMerchantId,
        categoryId,
        categoryName: categoryNameRaw,
      });

      if (!src) {
        return res.status(404).json({
          success: false,
          error: `Source category not found in Firestore for merchant ${fromMerchantId}`,
        });
      }

      const srcData = src.data || {};
      const categoryName = (srcData.category_name || categoryNameRaw || "").toString().trim();
      if (!categoryName) return res.status(400).json({ success: false, error: "Source category_name empty" });

      // Check if destination already has it (by name)
      const destExisting = await findCategoryForMerchant({
        firestore,
        merchantId: toMerchantId,
        categoryId: null,
        categoryName,
      });

      if (destExisting && destExisting.data && destExisting.data.is_deleted === false) {
        return res.json({
          success: true,
          alreadyExists: true,
          toMerchantId,
          categoryName,
          categoryId: destExisting.data.category_id,
        });
      }

      // Create in Square destination
      const squareClient = await createSquareClientForMerchant({ merchantId: toMerchantId });
      const created = await upsertSquareCategory({ squareClient, categoryName });

      // Upsert Firestore destination doc
      const fetchedAt = nowIso();
      const docId = `${toMerchantId}__${created.categoryId}`;

      await firestore.collection("square_categories").doc(docId).set(
        {
          merchant_id: toMerchantId,
          category_id: created.categoryId,
          category_name: categoryName,
          version: created.squareObject?.version ?? null,
          is_deleted: false,
          fetched_at: fetchedAt,
          updated_at: fetchedAt,
          square_raw: created.squareObject || null,
          copied_from: {
            from_merchant_id: fromMerchantId,
            from_category_id: srcData.category_id || categoryId || null,
            ts: fetchedAt,
            actor: req.user?.email || null,
          },
        },
        { merge: true }
      );

      return res.json({
        success: true,
        alreadyExists: false,
        toMerchantId,
        categoryName,
        newCategoryId: created.categoryId,
      });
    } catch (err) {
      console.error("Error in POST /api/categories/copy:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  // ------------------------------------------------------------
  // DELETE category across ALL merchants (Square + Firestore)
  // body:
  // {
  //   categoryKey,          // your normalized key (optional)
  //   categoryName,         // preferred when deleting all
  //   merchantCategoryMap:  // optional explicit map: { merchantId: { category_id } }
  // }
  //
  // We delete by enumerating Firestore square_categories rows that match categoryName,
  // across merchants, then deleting those Square category_ids.
  // ------------------------------------------------------------
  router.post("/api/categories/delete-all", requireLogin, async (req, res) => {
    try {
      const categoryName = (req.body?.categoryName || "").toString().trim();
      if (!categoryName) return res.status(400).json({ success: false, error: "categoryName required" });

      // Find all FS docs with this category name (exact match)
      const snap = await firestore.collection("square_categories").where("category_name", "==", categoryName).get();
      const docs = snap.docs.map(d => ({ ref: d.ref, id: d.id, data: d.data() || {} }))
        .filter(x => x.data && x.data.merchant_id && x.data.category_id);

      if (!docs.length) {
        return res.status(404).json({ success: false, error: `No Firestore categories found for name: ${categoryName}` });
      }

      // Group by merchant
      const byMerchant = new Map();
      for (const d of docs) {
        const mid = d.data.merchant_id;
        if (!byMerchant.has(mid)) byMerchant.set(mid, []);
        byMerchant.get(mid).push(d);
      }

      const results = [];
      const ts = nowIso();

      // For each merchant: delete in Square, then mark FS is_deleted
      for (const [merchantId, list] of byMerchant.entries()) {
        let squareOk = true;
        let squareError = null;

        try {
          const squareClient = await createSquareClientForMerchant({ merchantId });

          // delete all category_ids that match the name for this merchant
          for (const d of list) {
            try {
              await deleteSquareCategory({ squareClient, categoryId: d.data.category_id });
            } catch (e) {
              // If one fails, record but continue to mark Firestore so UI stops showing it
              squareOk = false;
              squareError = squareError || (e.message || String(e));
            }
          }
        } catch (e) {
          squareOk = false;
          squareError = e.message || String(e);
        }

        // Mark Firestore docs as deleted regardless (so matrix reflects immediately)
        const batch = firestore.batch();
        for (const d of list) {
          batch.set(d.ref, {
            is_deleted: true,
            deleted_at: ts,
            deleted_by: req.user?.email || null,
            delete_action: "delete-all",
          }, { merge: true });
        }
        await batch.commit();

        results.push({
          merchantId,
          count: list.length,
          squareOk,
          squareError,
          deletedInFirestore: true,
        });
      }

      // audit
      await firestore.collection("audit_logs").add({
        type: "DELETE_CATEGORY_ALL_MERCHANTS",
        category_name: categoryName,
        ts,
        actor: req.user?.email || null,
        results,
      });

      return res.json({ success: true, categoryName, results });
    } catch (err) {
      console.error("Error in POST /api/categories/delete-all:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
