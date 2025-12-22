// routes/inventory.js
const express = require('express');

module.exports = function buildInventoryRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // GET /api/inventory?merchantId=...&pageSize=50&cursor=...&q=...
  router.get('/api/inventory', requireLogin, async (req, res) => {
    try {
      const merchantId = req.query.merchantId || null;
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 500);
      const cursorRaw = req.query.cursor || null;

      const qRaw = (req.query.q || '').trim();
      const qNorm = qRaw.toLowerCase().replace(/\s+/g, ''); // "375 ml" -> "375ml"

      const colRef = merchantId
        ? firestore.collection('merchants').doc(merchantId).collection('inventory')
        : firestore.collection('inventory');

      // -----------------------------
      // Cursor decode (supports old docId cursors)
      // -----------------------------
      let cursor = null; // { m, id, v }
      if (cursorRaw) {
        try {
          const decoded = JSON.parse(Buffer.from(cursorRaw, 'base64').toString('utf8'));
          if (decoded && typeof decoded === 'object' && decoded.m && decoded.id) cursor = decoded;
        } catch {
          cursor = { m: 'doc', id: cursorRaw };
        }
      }

      // -----------------------------
      // Choose mode
      // -----------------------------
      const isDigitsNorm = /^[0-9]+$/.test(qNorm);
      const looksLikeToken = qNorm && qNorm.length <= 64;

      let mode = cursor?.m || null;

      if (!qNorm) mode = 'doc';

      if (!mode) {
        if (isDigitsNorm && qNorm.length >= 8) mode = 'gtin';
        else if (looksLikeToken) mode = 'token';
        else mode = 'item_prefix';
      }

      // -----------------------------
      // Build query
      // -----------------------------
      const buildQuery = (m) => {
        if (m === 'gtin') {
          return colRef.where('gtin', '==', qNorm).orderBy('__name__').limit(pageSize);
        }

        if (m === 'token') {
          return colRef
            .where('search_tokens', 'array-contains', qNorm)
            .orderBy('__name__')
            .limit(pageSize);
        }

        if (m === 'item_prefix') {
          return colRef
            .orderBy('item_name_lc')
            .orderBy('__name__')
            .startAt(qNorm)
            .endAt(qNorm + '\uf8ff')
            .limit(pageSize);
        }

        return colRef.orderBy('__name__').limit(pageSize);
      };

      // -----------------------------
      // Apply cursor
      // -----------------------------
      const applyCursor = async (query, m) => {
        if (!cursor || !cursor.id) return query;

        if (m === 'item_prefix') {
          if (typeof cursor.v === 'string') return query.startAfter(cursor.v, cursor.id);
          return query;
        }

        const snap = await colRef.doc(cursor.id).get();
        if (snap.exists) return query.startAfter(snap);
        return query;
      };

      // -----------------------------
      // Run query
      // -----------------------------
      let query = buildQuery(mode);
      query = await applyCursor(query, mode);

      let snap = await query.get();

      // Optional fallback: if GTIN search returns nothing, try token (page 1 only)
      if (!cursorRaw && qNorm && snap.empty && mode === 'gtin') {
        mode = 'token';
        snap = await buildQuery(mode).get();
      }

      // -----------------------------
      // ✅ Normalize image fields for UI
      // -----------------------------
      const normalizeImageUrls = (d) => {
        // already an array
        if (Array.isArray(d.image_urls)) return d.image_urls.filter(Boolean);

        // a single url string stored by you
        if (typeof d.image_url === 'string' && d.image_url.trim()) return [d.image_url.trim()];

        // if you stored one in image_urls as string
        if (typeof d.image_urls === 'string' && d.image_urls.trim()) return [d.image_urls.trim()];

        return [];
      };

      const rows = snap.docs.map(doc => {
        const data = doc.data() || {};
        const image_urls = normalizeImageUrls(data);

        return {
          id: doc.id,
          ...data,
          image_urls,             // ✅ guarantees array
          image_url: image_urls[0] || data.image_url || null, // optional convenience
        };
      });

      // -----------------------------
      // Next cursor (base64 JSON with mode)
      // -----------------------------
      let nextCursor = null;
      if (snap.size > 0) {
        const last = snap.docs[snap.docs.length - 1];

        if (mode === 'item_prefix') {
          const v = String(last.data().item_name_lc || '');
          nextCursor = Buffer.from(JSON.stringify({ m: 'item_prefix', v, id: last.id }), 'utf8').toString('base64');
        } else {
          nextCursor = Buffer.from(JSON.stringify({ m: mode, id: last.id }), 'utf8').toString('base64');
        }
      }

      res.json({ rows, nextCursor, mode });
    } catch (err) {
      console.error('Error in /api/inventory:', err);
      res.status(500).json({ error: err.message || 'Internal error loading inventory' });
    }
  });

  return router;
};
