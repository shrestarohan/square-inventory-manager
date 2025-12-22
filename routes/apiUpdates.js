const express = require('express');

module.exports = function buildApiUpdatesRouter({
  requireLogin,
  firestore,
  createSquareClient,
}) {
  const router = express.Router();

  // POST /api/update-price
  router.post('/api/update-price', requireLogin, async (req, res) => {
    try {
      const { merchantId, variationId, price, currency } = req.body;

      if (!merchantId || !variationId || price == null) {
        return res.status(400).json({ error: 'merchantId, variationId, and price are required' });
      }

      const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
      if (!merchantDoc.exists) {
        return res.status(404).json({ error: 'Merchant not found' });
      }

      const merchant = merchantDoc.data();
      const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

      const numericPrice = Number(price);
      if (Number.isNaN(numericPrice)) {
        return res.status(400).json({ error: 'Invalid price value' });
      }

      // 1) Retrieve the variation from Square
      const variationRes = await client.catalogApi.retrieveCatalogObject(variationId, true);
      const variationObj = variationRes.result.object;

      if (!variationObj || variationObj.type !== 'ITEM_VARIATION') {
        return res.status(400).json({ error: 'Catalog object is not an ITEM_VARIATION' });
      }

      const variationData = variationObj.itemVariationData || {};

      // 2) Update priceMoney
      variationData.priceMoney = {
        amount: Math.round(numericPrice * 100),
        currency: currency || variationData.priceMoney?.currency || 'USD',
      };

      variationObj.itemVariationData = variationData;

      // 3) Upsert back to Square
      await client.catalogApi.upsertCatalogObject({
        idempotencyKey: `price-${variationId}-${Date.now()}`,
        object: variationObj,
      });

      // 4) Update Firestore inventory docs (master + merchant mirror)
      const invSnapshot = await firestore
        .collection('inventory')
        .where('merchant_id', '==', merchantId)
        .where('variation_id', '==', variationId)
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

      // OPTIONAL: keep consolidated matrix in sync immediately (if you use it on dashboard-gtin)
      for (const gtin of touchedGtins) {
        const matrixRef = firestore.collection('gtin_inventory_matrix').doc(gtin);
        const matrixDoc = await matrixRef.get();
        if (!matrixDoc.exists) continue;

        const m = matrixDoc.data() || {};
        const pb = m.pricesByLocation || {};
        let changed = false;

        for (const [locKey, info] of Object.entries(pb)) {
          if (info?.merchant_id === merchantId && info?.variation_id === variationId) {
            pb[locKey] = { ...info, price: numericPrice, currency: newCurrency, updated_at: nowIso };
            changed = true;
          }
        }

        if (changed) {
          batch.set(matrixRef, { pricesByLocation: pb, updated_at: nowIso }, { merge: true });
        }
      }

      await batch.commit();
      return res.json({ success: true });
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
