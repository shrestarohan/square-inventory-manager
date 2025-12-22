// routes/gtinDuplicates.js
const express = require('express');

module.exports = function buildGtinDuplicatesRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // Data API
  // GET /api/gtin-duplicates?merchantId=...&mode=gtin|gtin_location&top=1000
  router.get('/api/gtin-duplicates', requireLogin, async (req, res) => {
    try {
      const merchantId = (req.query.merchantId || '').trim();
      const mode = (req.query.mode || 'gtin').trim(); // 'gtin' or 'gtin_location'
      const top = Math.min(Number(req.query.top) || 200, 2000);

      if (!merchantId) {
        return res.status(400).json({ error: 'merchantId is required' });
      }

      const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
      if (!merchantDoc.exists) {
        return res.status(404).json({ error: `Merchant ${merchantId} not found` });
      }

      const invRef = firestore.collection('merchants').doc(merchantId).collection('inventory');

      // Scan in pages (safe for 30K+)
      const PAGE = 1000;
      let lastDoc = null;

      const counts = new Map();     // key -> count
      const samples = new Map();    // key -> sample row (name/sku/category/location)
      let totalDocs = 0;
      let withGtin = 0;

      while (true) {
        let q = invRef.orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);

        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          totalDocs++;
          const d = doc.data() || {};
          const gtin = (d.gtin || '').toString().trim();
          if (!gtin) continue;

          withGtin++;

          const locationId = (d.location_id || '').toString().trim();
          const key =
            mode === 'gtin_location'
              ? `${gtin}|${locationId || 'NO_LOCATION'}`
              : gtin;

          counts.set(key, (counts.get(key) || 0) + 1);

          if (!samples.has(key)) {
            samples.set(key, {
              gtin,
              location_id: locationId || '',
              location_name: d.location_name || '',
              item_name: d.item_name || '',
              sku: d.sku || '',
              category_name: d.category_name || '',
            });
          }
        }

        lastDoc = snap.docs[snap.docs.length - 1];
      }

      const dupes = Array.from(counts.entries())
        .filter(([, c]) => c > 1) // ✅ only true duplicates
        .map(([key, c]) => {
          const s = samples.get(key) || {};
          let gtin = s.gtin || key;
          let location_id = s.location_id || '';

          if (mode === 'gtin_location') {
            const parts = key.split('|');
            gtin = parts[0] || gtin;
            location_id = parts[1] || location_id;
          }

          return {
            key,
            gtin,
            location_id,
            location_name: s.location_name || '',
            count: c,
            item_name: s.item_name || '',
            sku: s.sku || '',
            category_name: s.category_name || '',
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, top);

      res.json({
        merchantId,
        merchantName: merchantDoc.data()?.business_name || merchantId,
        mode,
        totalDocs,
        withGtin,
        duplicateKeys: dupes.length,
        dupes,
      });
    } catch (err) {
      console.error('Error in /api/gtin-duplicates:', err);
      res.status(500).json({ error: err.message || 'Failed to compute duplicates' });
    }
  });

  return router;
};
