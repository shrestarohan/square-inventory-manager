// routes/inventoryIntegrityRoutes.js
const express = require('express');
const { FieldValue } = require('@google-cloud/firestore');
const { Client, Environment } = require('square/legacy');

const { listNegatives, writeFixAudit } = require('../services/negativeInventoryService');

function resolveInventoryDocRef({ firestore, merchantId, docId }) {
  return merchantId
    ? firestore.collection('merchants').doc(merchantId).collection('inventory').doc(docId)
    : firestore.collection('inventory').doc(docId);
}

function refsForDoc({ firestore, merchantId, docId }) {
  const masterRef = firestore.collection('inventory').doc(docId);
  const merchantRef = merchantId
    ? firestore.collection('merchants').doc(merchantId).collection('inventory').doc(docId)
    : null;
  return { masterRef, merchantRef };
}

function createSquareClient(accessToken, env) {
  return new Client({
    environment: env === 'sandbox' ? Environment.Sandbox : Environment.Production,
    bearerAuthCredentials: { accessToken },
  });
}

function stripUndefined(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) return obj.map(stripUndefined).filter(v => v !== undefined);
  if (typeof obj !== 'object') return obj;

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const vv = stripUndefined(v);
    if (vv !== undefined) out[k] = vv;
  }
  return out;
}

async function pushPhysicalCountToSquare({ firestore, merchantId, locationId, variationId, countedQty }) {
  const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
  if (!merchantDoc.exists) throw new Error('Merchant not found for Square push');

  const merchant = merchantDoc.data();
  const client = createSquareClient(merchant.access_token, merchant.env || 'sandbox');

  const idempotencyKey = `invfix-${merchantId}-${variationId}-${locationId}-${Date.now()}`;

  const body = {
    idempotencyKey,
    changes: [{
      type: 'PHYSICAL_COUNT',
      physicalCount: {
        catalogObjectId: variationId,
        locationId,
        quantity: String(countedQty),
        state: 'IN_STOCK',
        occurredAt: new Date().toISOString(),
      }
    }]
  };

  const resp = await client.inventoryApi.batchChangeInventory(body);
  return { idempotencyKey, result: resp.result };
}

module.exports = function buildInventoryIntegrityRoutes({ firestore, requireLogin, createSquareClient }) {
  const router = express.Router();

  // protect everything in this router
  if (requireLogin) router.use(requireLogin);

  // GET /inventory/negatives?merchantId=...&limit=200&q=...
  router.get('/inventory/negatives', async (req, res) => {
    try {
      const merchantId = req.query.merchantId || null;
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const q = req.query.q || '';

      const rows = await listNegatives({ firestore, merchantId, limit, q });
      res.json({ ok: true, count: rows.length, rows });
    } catch (e) {
      console.error('negatives error', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /inventory/fix
  // body: { merchantId?, docId, action: "ADJUST_TO_ZERO"|"SET_COUNTED_QTY", note?, countedQty?, applyToSquare? }
  router.post('/inventory/fix', async (req, res) => {
    try {
      const { merchantId = null, docId, action, note = "", countedQty, applyToSquare = true } = req.body || {};
      if (!docId || !action) return res.status(400).json({ ok: false, error: 'docId and action required' });

      if (!['ADJUST_TO_ZERO', 'SET_COUNTED_QTY'].includes(action)) {
        return res.status(400).json({ ok: false, error: 'Unsupported action' });
      }

      let targetQty = null;
      if (action === 'ADJUST_TO_ZERO') targetQty = 0;

      if (action === 'SET_COUNTED_QTY') {
        const n = Number(countedQty);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ ok: false, error: 'countedQty must be a number >= 0' });
        }
        targetQty = n;
      }

      const ref = resolveInventoryDocRef({ firestore, merchantId, docId });

      // Read doc first (we need variation/location to push to Square)
      const beforeSnap = await ref.get();
      if (!beforeSnap.exists) throw new Error('Inventory doc not found');
      const before = beforeSnap.data();
      const beforeQty = Number(before.qty || 0);

      // Require merchant/location/variation to push to Square
      const mId = merchantId || before.merchant_id || null;
      const locationId = before.location_id || null;
      const variationId = before.variation_id || null;

      // 1) Push to Square first (source of truth)
      let squareMeta = null;

      if (applyToSquare) {
        if (!mId || !locationId || !variationId) {
          return res.status(400).json({
            ok: false,
            error: 'Missing merchantId/location_id/variation_id required to push count to Square',
          });
        }

        const pushed = await pushPhysicalCountToSquare({
          firestore,
          merchantId: mId,
          locationId,
          variationId,
          countedQty: targetQty,
        });

        squareMeta = {
          idempotencyKey: pushed.idempotencyKey,
          changeCount: Array.isArray(pushed.result?.counts) ? pushed.result.counts.length : null,
        };
      }

      // 2) Update Firestore (mirror)
      const { masterRef, merchantRef } = refsForDoc({ firestore, merchantId: mId, docId });
      let result = null;

      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('Inventory doc not found');

        const curQty = Number(snap.data()?.qty || 0);

        const patch = {
          qty: targetQty,
          updated_at: FieldValue.serverTimestamp(),
          integrity_last_fix: FieldValue.serverTimestamp(),
          integrity_fix_action: action,
          integrity_fix_note: note || '',
        };

        tx.set(masterRef, patch, { merge: true });
        if (merchantRef) tx.set(merchantRef, patch, { merge: true });

        result = { changed: true, beforeQty: curQty, afterQty: targetQty };
      });

      // 3) Audit
      await writeFixAudit({
        firestore,
        payload: stripUndefined({
          action,
          merchant_id: mId,
          inventory_doc_id: docId,
          before_qty: beforeQty,
          after_qty: targetQty,
          counted_qty: action === 'SET_COUNTED_QTY' ? targetQty : null,
          note,
          actor: req.user?.email || req.user?.id || 'unknown',
          square_applied: !!applyToSquare,
          square_result: squareMeta ? {
            idempotencyKey: squareMeta.idempotencyKey || null,
            changeCount: squareMeta.changeCount ?? null,
          } : null,
          square_location_id: locationId || null,
          square_variation_id: variationId || null,
        }),
      });

      res.json({ ok: true, result, squareApplied: !!applyToSquare, squareMeta });
    } catch (e) {
      console.error('fix error', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /inventory/row?merchantId=...&docId=...
  router.get('/inventory/row', async (req, res) => {
    try {
      const merchantId = req.query.merchantId || null;
      const docId = req.query.docId;
      if (!docId) return res.status(400).json({ ok: false, error: 'docId required' });

      const ref = resolveInventoryDocRef({ firestore, merchantId, docId });
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: 'Not found' });

      const d = snap.data();
      res.json({
        ok: true,
        row: {
          id: snap.id,
          merchant_id: d.merchant_id || merchantId || null,
          location_id: d.location_id || null,
          location_name: d.location_name || null,
          gtin: d.gtin || null,
          name: d.name || d.item_name || null,
          sku: d.sku || null,
          qty: d.qty,
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
