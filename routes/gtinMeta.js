// routes/gtinMeta.js
const express = require('express');

module.exports = function buildGtinMetaRouter({ firestore, requireLogin, createSquareClient }) {
  const router = express.Router();

  // GET /api/gtin-meta?pageSize=50&cursor=...&q=...
  router.get('/api/gtin-meta', requireLogin, async (req, res) => {
    try {
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 500);
      const cursor = req.query.cursor || null;

      const qRaw = (req.query.q || '').trim();
      const q = qRaw.toLowerCase().replace(/\s+/g, '');

      const colRef = firestore.collection('gtinMeta');
      const isDigits = /^[0-9]+$/.test(q);

      let query = null;
      let cursorMode = 'docId'; // 'docId' or 'composite'

      if (q) {
        if (isDigits && q.length >= 8) {
          const doc = await colRef.doc(qRaw).get();
          if (!doc.exists) return res.json({ rows: [], nextCursor: null });

          return res.json({
            rows: [{ id: doc.id, ...doc.data() }],
            nextCursor: null,
          });
        }

        // Prefix search on itemName_lc (requires itemName_lc in docs)
        query = colRef
          .orderBy('itemName_lc')
          .orderBy('__name__')
          .startAt(q)
          .endAt(q + '\uf8ff')
          .limit(pageSize);

        cursorMode = 'composite';
      } else {
        query = colRef.orderBy('__name__').limit(pageSize);
        cursorMode = 'docId';
      }

      if (cursor) {
        if (cursorMode === 'docId') {
          const cursorDoc = await colRef.doc(cursor).get();
          if (cursorDoc.exists) query = query.startAfter(cursorDoc);
        } else {
          let decoded = null;
          try {
            decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
          } catch {}
          if (decoded && typeof decoded.v === 'string' && typeof decoded.id === 'string') {
            query = query.startAfter(decoded.v, decoded.id);
          }
        }
      }

      const snap = await query.get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      let nextCursor = null;
      if (snap.size > 0) {
        const last = snap.docs[snap.docs.length - 1];
        if (cursorMode === 'docId') {
          nextCursor = last.id;
        } else {
          const v = (last.data().itemName_lc || '').toString();
          nextCursor = Buffer.from(JSON.stringify({ v, id: last.id }), 'utf8').toString('base64');
        }
      }

      res.json({ rows, nextCursor });
    } catch (err) {
      console.error('Error in /api/gtin-meta:', err);
      res.status(500).json({ error: err.message || 'Failed to load gtinMeta' });
    }
  });

  // PUT /api/gtin-meta/:gtin
  router.put('/api/gtin-meta/:gtin', requireLogin, async (req, res) => {
    try {
      const gtin = (req.params.gtin || '').trim();
      if (!gtin) return res.status(400).json({ error: 'Missing gtin' });

      const sku = req.body.sku != null ? String(req.body.sku).trim() : null;
      const itemName = req.body.itemName != null ? String(req.body.itemName).trim() : null;
      const vendorName = req.body.vendorName != null ? String(req.body.vendorName).trim() : null;

      let unitCost = null;
      if (req.body.unitCost !== undefined) {
        unitCost = (req.body.unitCost === null || req.body.unitCost === '')
          ? null
          : Number(req.body.unitCost);
        if (unitCost !== null && Number.isNaN(unitCost)) {
          return res.status(400).json({ error: 'unitCost must be a number or null' });
        }
      }

      const nowIso = new Date().toISOString();

      // 1) Save GTIN meta (Firestore)
      const gtinMetaRef = firestore.collection('gtinMeta').doc(gtin);
      await gtinMetaRef.set({
        sku: sku || null,
        itemName: itemName || null,
        itemName_lc: itemName ? itemName.toLowerCase() : undefined,
        vendorName: vendorName || null,
        unitCost: unitCost,
        updatedAt: nowIso,
      }, { merge: true });

      // 2) Save canonical name overlay
      if (itemName) {
        await firestore.collection('item_master').doc(gtin).set({
          canonical_name: itemName,
          updated_at: nowIso,
        }, { merge: true });
      }

      // If you want the “push to Square + propagate inventory docs” behavior,
      // keep using your previous full implementation (we can drop it in here).
      // This minimal router only saves meta and canonical name.

      const metaSnap = await gtinMetaRef.get();

      res.json({
        success: true,
        gtin,
        gtinMeta: { id: metaSnap.id, ...metaSnap.data() },
        note: 'Saved gtinMeta + item_master. (Square propagation not included in this minimal router.)',
      });
    } catch (err) {
      console.error('Error updating gtin meta:', err);
      res.status(500).json({ error: err.message || 'Failed to update GTIN meta' });
    }
  });

  return router;
};
