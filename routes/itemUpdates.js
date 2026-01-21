const express = require('express');
const { writeAuditLog } = require('../lib/audit');

module.exports = function buildApiUpdatesRouter({
  requireLogin,
  firestore,
  createSquareClient,
}) {
  const router = express.Router();

  // POST /api/update-item-price
  router.post('/api/update-item-price', requireLogin, async (req, res) => {
    try {
      const { merchantId, variationId, price, currency, gtin, locKey } = req.body;
      console.log("update-item-price:", { merchantId, variationId, price, currency, gtin, locKey });

      if (!merchantId || price == null) {
        return res.status(400).json({ error: 'merchantId and price are required' });
      }

      const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
      if (!merchantDoc.exists) {
        return res.status(404).json({ error: 'Merchant not found' });
      }

      const merchant = merchantDoc.data() || {};

      // ✅ IMPORTANT: default env should not silently be sandbox
      const env = (merchant.env || process.env.SQUARE_ENV || 'production').toString();

      const client = createSquareClient(merchant.access_token, env);

      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice)) {
        return res.status(400).json({ error: 'Invalid price value' });
      }

      // ----------------------------
      // Helpers to resolve correct variationId if passed one 404s
      // ----------------------------
      async function resolveVariationIdFallback() {
        // 1) If gtin+locKey provided, try matrix (best)
        if (gtin && locKey) {
          const mSnap = await firestore.collection('gtin_inventory_matrix').doc(String(gtin)).get();
          if (mSnap.exists) {
            const m = mSnap.data() || {};
            const pb = m.pricesByLocation || {};
            const info = pb[locKey];
            const v = (info?.variation_id || '').toString().trim();
            const mid = (info?.merchant_id || '').toString().trim();
            if (v && (!mid || mid === merchantId)) return v;
          }
        }

        // 2) Try merchant inventory doc merchants/{merchantId}/inventory/{gtin}
        if (gtin) {
          const invDoc = await firestore
            .collection('merchants')
            .doc(merchantId)
            .collection('inventory')
            .doc(String(gtin))
            .get();

          if (invDoc.exists) {
            const d = invDoc.data() || {};
            const v = (d.variation_id || d.square_variation_id || '').toString().trim();
            if (v) return v;
          }

          // 3) Fallback: query global inventory by merchant_id + gtin
          const invSnap = await firestore
            .collection('inventory')
            .where('merchant_id', '==', merchantId)
            .where('gtin', '==', String(gtin))
            .limit(1)
            .get();

          if (!invSnap.empty) {
            const d = invSnap.docs[0].data() || {};
            const v = (d.variation_id || d.square_variation_id || '').toString().trim();
            if (v) return v;
          }
        }

        return null;
      }

      async function retrieveVariationOrNull(vId) {
        try {
          const r = await client.catalogApi.retrieveCatalogObject(vId, true);
          return r?.result?.object || null;
        } catch (e) {
          if (e?.statusCode === 404) return null;
          throw e;
        }
      }

      // ----------------------------
      // 1) Retrieve the variation from Square (verify it exists)
      // ----------------------------
      let finalVariationId = (variationId || '').toString().trim() || null;

      let variationObj = finalVariationId ? await retrieveVariationOrNull(finalVariationId) : null;

      // If not found, try to resolve the correct variation ID for this merchant and retry
      if (!variationObj) {
        const fallbackVarId = await resolveVariationIdFallback();
        if (fallbackVarId) {
          finalVariationId = fallbackVarId;
          variationObj = await retrieveVariationOrNull(finalVariationId);
        }
      }

      if (!finalVariationId) {
        return res.status(400).json({
          error: 'variationId is missing and could not be resolved. Send variationId or send gtin + locKey.',
        });
      }

      if (!variationObj) {
        return res.status(404).json({
          error: `Square variation not found for this merchant. variationId=${finalVariationId}`,
          hint: 'This usually means you are using a variation_id from a different store/merchant. Re-copy item or ensure UI is sending destination variation_id.',
        });
      }

      if (variationObj.type !== 'ITEM_VARIATION') {
        return res.status(400).json({ error: 'Catalog object is not an ITEM_VARIATION' });
      }

      const variationData = variationObj.itemVariationData || {};

      // ----------------------------
      // 2) Update priceMoney
      // ----------------------------
      variationData.priceMoney = {
        amount: Math.round(numericPrice * 100),
        currency: (currency || variationData.priceMoney?.currency || 'USD').toString().toUpperCase(),
      };

      variationObj.itemVariationData = variationData;

      // ----------------------------
      // 3) Upsert back to Square
      // ----------------------------
      await client.catalogApi.upsertCatalogObject({
        idempotencyKey: `price-${finalVariationId}-${Date.now()}`,
        object: variationObj,
      });

      // ----------------------------
      // 4) Update Firestore inventory docs
      //    IMPORTANT: use finalVariationId (resolved) not the stale incoming one
      // ----------------------------
      const invSnapshot = await firestore
        .collection('inventory')
        .where('merchant_id', '==', merchantId)
        .where('variation_id', '==', finalVariationId)
        .get();

      const batch = firestore.batch();
      const nowIso = new Date().toISOString();
      const newCurrency = variationData.priceMoney.currency || 'USD';

      const touchedGtins = new Set();

      invSnapshot.forEach((doc) => {
        const d = doc.data() || {};
        if (d.gtin) touchedGtins.add(String(d.gtin));

        batch.set(
          doc.ref,
          { price: numericPrice, currency: newCurrency, updated_at: nowIso },
          { merge: true }
        );

        const merchantInvRef = firestore
          .collection('merchants')
          .doc(merchantId)
          .collection('inventory')
          .doc(doc.id);

        batch.set(
          merchantInvRef,
          { price: numericPrice, currency: newCurrency, updated_at: nowIso },
          { merge: true }
        );
      });

      // OPTIONAL: matrix sync (match by merchant_id + variation_id)
      for (const g of touchedGtins) {
        const matrixRef = firestore.collection('gtin_inventory_matrix').doc(g);
        const matrixDoc = await matrixRef.get();
        if (!matrixDoc.exists) continue;

        const m = matrixDoc.data() || {};
        const pb = m.pricesByLocation || {};
        let changed = false;

        for (const [lk, info] of Object.entries(pb)) {
          if (info?.merchant_id === merchantId && info?.variation_id === finalVariationId) {
            pb[lk] = { ...info, price: numericPrice, currency: newCurrency, updated_at: nowIso };
            changed = true;
          }
        }

        if (changed) {
          batch.set(matrixRef, { pricesByLocation: pb, updated_at: nowIso }, { merge: true });
        }
      }

      await batch.commit();

      // after successful Square + Firestore update:
      await writeAuditLog(firestore, {
        req,
        action: 'price.update',
        targetType: 'gtin_location',
        targetId: `${gtin}|${locKey}`,
        meta: { gtin, locKey, merchantId, variationId, newPrice: price, currency }
      });

      return res.json({ success: true, variationId: finalVariationId });
    } catch (err) {
      console.error('Error in /api/update-price', err);
      res.status(500).json({ error: err.message || 'Failed to update price' });
    }
  });


  // POST /api/update-item-name
  router.post('/api/update-item-name', requireLogin, async (req, res) => {
    try {
      const { gtin, itemName } = req.body;

      if (!gtin || !itemName) {
        return res.status(400).json({ error: 'gtin and itemName are required' });
      }

      const trimmedName = String(itemName).trim();
      if (!trimmedName) {
        return res.status(400).json({ error: 'itemName cannot be empty' });
      }

      const nowIso = new Date().toISOString();

      // 1) Save / update master canonical name
      await firestore.collection('item_master').doc(String(gtin)).set(
        { canonical_name: trimmedName, updated_at: nowIso },
        { merge: true }
      );

      // 2) Find all inventory docs with this GTIN
      const invSnapshot = await firestore
        .collection('inventory')
        .where('gtin', '==', String(gtin))
        .get();

      // 2b) If nothing, still update consolidated matrix doc if present
      if (invSnapshot.empty) {
        await firestore.collection('gtin_inventory_matrix').doc(String(gtin)).set(
          { item_name: trimmedName, item_name_lc: trimmedName.toLowerCase(), updated_at: nowIso },
          { merge: true }
        );
        return res.json({ success: true, updatedItems: 0, updatedDocs: 0 });
      }

      // Build unique (merchant_id, item_id) combos for Square ITEM rename
      const comboMap = new Map(); // key: merchantId|itemId
      invSnapshot.forEach((doc) => {
        const d = doc.data() || {};
        const merchantId = d.merchant_id;
        const itemId = d.item_id;
        if (!merchantId || !itemId) return;
        const key = `${merchantId}|${itemId}`;
        if (!comboMap.has(key)) comboMap.set(key, { merchantId, itemId });
      });

      // 3) Update ITEM name in Square for each merchant
      for (const { merchantId, itemId } of comboMap.values()) {
        const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
        if (!merchantDoc.exists) continue;

        const merchant = merchantDoc.data();
        const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

        try {
          const itemRes = await client.catalogApi.retrieveCatalogObject(itemId, true);
          const itemObj = itemRes.result.object;

          if (!itemObj || itemObj.type !== 'ITEM') continue;

          itemObj.itemData = itemObj.itemData || {};
          itemObj.itemData.name = trimmedName;

          await client.catalogApi.upsertCatalogObject({
            idempotencyKey: `name-${itemId}-${Date.now()}`,
            object: itemObj,
          });
        } catch (e) {
          console.error(`Failed to update name in Square for merchant=${merchantId} item=${itemId}`, e?.message || e);
        }
      }

      // 4) Update Firestore item_name everywhere + consolidated matrix
      const batch = firestore.batch();

      invSnapshot.forEach((doc) => {
        batch.set(doc.ref, { item_name: trimmedName, item_name_lc: trimmedName.toLowerCase(), updated_at: nowIso }, { merge: true });

        const d = doc.data() || {};
        if (d.merchant_id) {
          const merchantInvRef = firestore
            .collection('merchants')
            .doc(d.merchant_id)
            .collection('inventory')
            .doc(doc.id);

          batch.set(merchantInvRef, { item_name: trimmedName, item_name_lc: trimmedName.toLowerCase(), updated_at: nowIso }, { merge: true });
        }
      });

      batch.set(
        firestore.collection('gtin_inventory_matrix').doc(String(gtin)),
        { item_name: trimmedName, item_name_lc: trimmedName.toLowerCase(), updated_at: nowIso },
        { merge: true }
      );

      await batch.commit();

      return res.json({ success: true, updatedItems: comboMap.size, updatedDocs: invSnapshot.size });
    } catch (err) {
      console.error('Error in /api/update-item-name', err);
      res.status(500).json({ error: err.message || 'Failed to update item name' });
    }
  });

  return router;
};
