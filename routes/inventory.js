// routes/inventory.js
const express = require('express');
const { FieldPath } = require('@google-cloud/firestore');

module.exports = function buildInventoryRouter({ firestore, requireLogin }) {
  const router = express.Router();

  // GET /api/inventory?merchantId=...&pageSize=50&cursor=...&q=...&onlyNoCategory=1
  router.get('/api/inventory', requireLogin, async (req, res) => {
    try {
      const merchantId = req.query.merchantId || null;
      const pageSize = Math.min(Number(req.query.pageSize) || 50, 500);
      const cursorRaw = req.query.cursor || null;

      const qRaw = (req.query.q || '').trim();
      const qNorm = qRaw.toLowerCase().replace(/\s+/g, ''); // "375 ml" -> "375ml"

      const onlyNoCategory =
        req.query.onlyNoCategory === '1' ||
        req.query.onlyNoCategory === 'true' ||
        req.query.onlyNoCategory === true;

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
      const looksLikeToken = !!(qNorm && qNorm.length <= 64);

      let mode = cursor?.m || null;

      // ✅ If OnlyNoCategory is ON, still honor q
      if (onlyNoCategory) {
        if (!qNorm) mode = 'no_category';
        else if (isDigitsNorm && qNorm.length >= 8) mode = 'no_category_gtin'; // digits => likely GTIN
        else mode = 'no_category_token';
      }

      // Default browsing (no query)
      if (!qNorm && !mode) mode = 'doc';

      // Normal modes when OnlyNoCategory is OFF
      if (!mode) {
        if (isDigitsNorm && qNorm.length >= 8) mode = 'gtin';
        else if (looksLikeToken) mode = 'token';
        else mode = 'item_prefix';
      }

      // -----------------------------
      // Build query
      // -----------------------------
      const buildQuery = (m) => {
        // ✅ only items with missing/null category_id
        if (m === 'no_category') {
          return colRef
            .where('category_id', '==', null) // matches null OR missing field
            .orderBy(FieldPath.documentId())
            .limit(pageSize);
        }

        // ✅ only no-category AND exact GTIN
        if (m === 'no_category_gtin') {
          return colRef
            .where('category_id', '==', null)
            .where('gtin', '==', qNorm)
            .orderBy(FieldPath.documentId())
            .limit(pageSize);
        }

        // ✅ only no-category AND exact SKU
        // Note: uses qRaw (not qNorm). If you store sku normalized, change to qNorm and query sku_norm.
        if (m === 'no_category_sku') {
          return colRef
            .where('category_id', '==', null)
            .where('sku', '==', qRaw)
            .orderBy(FieldPath.documentId())
            .limit(pageSize);
        }

        // ✅ only no-category AND token search
        if (m === 'no_category_token') {
          return colRef
            .where('category_id', '==', null)
            .where('search_tokens', 'array-contains', qNorm)
            .orderBy(FieldPath.documentId())
            .limit(pageSize);
        }

        if (m === 'gtin') {
          return colRef.where('gtin', '==', qNorm).orderBy(FieldPath.documentId()).limit(pageSize);
        }

        if (m === 'sku') {
          return colRef.where('sku', '==', qRaw).orderBy(FieldPath.documentId()).limit(pageSize);
        }

        if (m === 'token') {
          return colRef
            .where('search_tokens', 'array-contains', qNorm)
            .orderBy(FieldPath.documentId())
            .limit(pageSize);
        }

        if (m === 'item_prefix') {
          return colRef
            .orderBy('item_name_lc')
            .orderBy(FieldPath.documentId())
            .startAt(qNorm)
            .endAt(qNorm + '\uf8ff')
            .limit(pageSize);
        }

        return colRef.orderBy(FieldPath.documentId()).limit(pageSize);
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

      // -----------------------------
      // Fallbacks (page 1 only)
      // -----------------------------
      // These fallbacks ensure SKU+GTIN still work even with OnlyNoCategory on,
      // and numeric queries can match SKU if GTIN is empty.
      if (!cursorRaw && qNorm && snap.empty) {
        // When OnlyNoCategory is ON and query is numeric, try SKU exact after GTIN
        if (onlyNoCategory && mode === 'no_category_gtin') {
          mode = 'no_category_sku';
          snap = await buildQuery(mode).get();

          if (snap.empty) {
            mode = 'no_category_token';
            snap = await buildQuery(mode).get();
          }
        }

        // When OnlyNoCategory is ON and token search returned nothing, try item_prefix
        if (onlyNoCategory && mode === 'no_category_token' && snap.empty) {
          // You can optionally try item_prefix with no_category, but Firestore can't do "contains" easily here
          // so we just fall back to "no_category" (show all no-category items)
          mode = 'no_category';
          snap = await buildQuery(mode).get();
        }

        // When OnlyNoCategory is OFF: GTIN -> SKU -> token
        if (!onlyNoCategory && mode === 'gtin' && snap.empty) {
          mode = 'sku';
          snap = await buildQuery(mode).get();

          if (snap.empty) {
            mode = 'token';
            snap = await buildQuery(mode).get();
          }
        }
      }

      // -----------------------------
      // ✅ Normalize image fields for UI
      // -----------------------------
      const normalizeImageUrls = (d) => {
        if (Array.isArray(d.image_urls)) return d.image_urls.filter(Boolean);
        if (typeof d.image_url === 'string' && d.image_url.trim()) return [d.image_url.trim()];
        if (typeof d.image_urls === 'string' && d.image_urls.trim()) return [d.image_urls.trim()];
        return [];
      };

      const rows = snap.docs.map((doc) => {
        const data = doc.data() || {};
        const image_urls = normalizeImageUrls(data);

        return {
          id: doc.id,
          ...data,
          image_urls,
          image_url: image_urls[0] || data.image_url || null,
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

      res.json({ rows, nextCursor, mode, onlyNoCategory: !!onlyNoCategory });
    } catch (err) {
      console.error('Error in /api/inventory:', err);
      res.status(500).json({ error: err.message || 'Internal error loading inventory' });
    }
  });

  return router;
};
