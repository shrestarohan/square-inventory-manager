// routes/gtinDuplicates.js
const express = require('express');

module.exports = function buildGtinDuplicatesRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // GET /api/gtin-duplicates?merchantId=...&top=2000&maxDocs=50000
  router.get('/api/gtin-duplicates', requireLogin, async (req, res) => {
    try {
      const merchantId = (req.query.merchantId || '').trim();
      const top = Math.min(Number(req.query.top) || 200, 2000);
      const MAX_DOCS = Math.min(Number(req.query.maxDocs) || 50000, 250000);

      if (!merchantId) return res.status(400).json({ error: 'merchantId is required' });

      const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
      if (!merchantDoc.exists) {
        return res.status(404).json({ error: `Merchant ${merchantId} not found` });
      }

      const matrixRef = firestore.collection('gtin_inventory_matrix');

      const PAGE = 500; // matrix docs can be large due to nested maps
      let lastDoc = null;
      let scanned = 0;

      const dupes = [];

      while (true) {
        let q = matrixRef.orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);

        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          scanned++;
          if (scanned > MAX_DOCS) break;

          const m = doc.data() || {};
          const gtin = (m.gtin || doc.id || '').toString().trim();
          const pricesByLocation = m.pricesByLocation || {};

          // collect locations for this merchantId
          const hits = [];
          for (const [locKey, v] of Object.entries(pricesByLocation)) {
            if (!v) continue;
            if ((v.merchant_id || '').toString() !== merchantId) continue;

            hits.push({
              locKey,
              location_id: (v.location_id || '').toString(),
              location_name: (v.location_name || v.merchant_name || '').toString(),
              price: v.price ?? null,
              item_name: (v.item_name || m.item_name || '').toString(),
              sku: (v.sku || m.sku || '').toString(),
              category_name: (v.category_name || m.category_name || '').toString(),
            });
          }

          // duplicate across locations for this merchant
          if (hits.length > 1) {
            dupes.push({
              gtin,
              count: hits.length,
              locations: hits,
              item_name: hits[0]?.item_name || m.item_name || '',
              sku: hits[0]?.sku || m.sku || '',
              category_name: hits[0]?.category_name || m.category_name || '',
            });
          }
        }

        if (scanned > MAX_DOCS) break;
        lastDoc = snap.docs[snap.docs.length - 1];
      }

      dupes.sort((a, b) => b.count - a.count);
      const out = dupes.slice(0, top);

      res.json({
        merchantId,
        merchantName: merchantDoc.data()?.business_name || merchantId,
        source: 'gtin_inventory_matrix',
        scannedMatrixDocs: scanned,
        duplicateGtins: out.length,
        dupes: out,
      });
    } catch (err) {
      console.error('Error in /api/gtin-duplicates (matrix):', err);
      res.status(500).json({ error: err.message || 'Failed to compute duplicates' });
    }
  });

  return router;
};
