// routes/reorderRoutes.js
const express = require('express');
const router = express.Router();

function pctRound(n, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function ceilToPack(qty, pack) {
  const p = Number(pack || 1);
  if (!Number.isFinite(p) || p <= 1) return Math.ceil(qty);
  return Math.ceil(qty / p) * p;
}

router.get('/api/reorder', async (req, res) => {
  try {
    const firestore = req.app.locals.firestore;

    const merchantId = (req.query.merchantId || '').trim();
    const locationId = (req.query.locationId || '').trim();
    const days = Math.min(Math.max(Number(req.query.days) || 28, 7), 90);

    if (!merchantId || !locationId) {
      return res.status(400).json({ ok: false, error: 'merchantId and locationId are required' });
    }

    // Settings defaults (global)
    const defaultLead = Number(req.query.lead || 3);
    const defaultSafety = Number(req.query.safety || 2);

    // 1) Load inventory_snapshot for this merchant+location
    // If you haven't built snapshots yet, we can fallback later.
    const snapInv = await firestore.collection('inventory_snapshot')
      .where('merchant_id', '==', merchantId)
      .where('location_id', '==', locationId)
      .limit(5000)
      .get();

    let invRows = snapInv.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fallback if snapshot not built yet: use merchant subcollection inventory qty
    if (!invRows.length) {
      const invSnap = await firestore.collection('merchants').doc(merchantId).collection('inventory')
        .where('location_id', '==', locationId)
        .select('variation_id', 'item_name', 'sku', 'gtin', 'qty', 'location_id', 'location_name')
        .limit(5000)
        .get();

      invRows = invSnap.docs.map(d => {
        const x = d.data();
        return {
          merchant_id: merchantId,
          location_id: locationId,
          location_name: x.location_name || '',
          variation_id: x.variation_id,
          item_name: x.item_name || '',
          sku: x.sku || '',
          gtin: x.gtin || '',
          on_hand: Number(x.qty || 0),
        };
      });
    }

    // Map variation -> on_hand + meta
    const byVar = new Map();
    for (const r of invRows) {
      const v = r.variation_id;
      if (!v) continue;
      if (!byVar.has(v)) {
        byVar.set(v, {
          variation_id: v,
          item_name: r.item_name || r.name || '',
          sku: r.sku || '',
          gtin: r.gtin || '',
          on_hand: Number(r.on_hand ?? r.qty ?? 0),
          location_name: r.location_name || '',
        });
      } else {
        // if duplicates exist, sum on_hand
        byVar.get(v).on_hand += Number(r.on_hand ?? r.qty ?? 0);
      }
    }

    // 2) Load sales_daily for window
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const startDay = start.toISOString().slice(0, 10);

    const salesSnap = await firestore.collection('sales_daily')
      .where('merchant_id', '==', merchantId)
      .where('location_id', '==', locationId)
      .where('day', '>=', startDay)
      .limit(20000)
      .get();

    const soldByVar = new Map();
    salesSnap.forEach(doc => {
      const d = doc.data();
      const v = d.variation_id;
      if (!v) return;
      soldByVar.set(v, (soldByVar.get(v) || 0) + Number(d.qty_sold || 0));
    });

    // 3) Settings (optional per variation)
    // v1: read per-variation settings if exist; else defaults
    // DocId: `${merchantId}|${locationId}|${variationId}`
    const results = [];
    const nowIso = new Date().toISOString();

    for (const [variationId, base] of byVar.entries()) {
      const sold = soldByVar.get(variationId) || 0;
      const avgDaily = sold / days;

      // skip dead items unless user asks
      if (avgDaily <= 0 && base.on_hand > 0) continue;

      const settingsId = `${merchantId}|${locationId}|${variationId}`;
      const sDoc = await firestore.collection('reorder_settings').doc(settingsId).get();
      const s = sDoc.exists ? sDoc.data() : {};

      const lead = Number(s.lead_time_days ?? defaultLead);
      const safety = Number(s.safety_days ?? defaultSafety);
      const pack = Number(s.pack_size ?? 1);
      const minQty = Number(s.min_qty ?? 0);
      const unitCost = (s.unit_cost != null) ? Number(s.unit_cost) : null;
      const vendor = s.vendor || '';

      const target = avgDaily * (lead + safety);
      let reorder = Math.max(0, target - base.on_hand);
      reorder = ceilToPack(reorder, pack);
      if (reorder > 0 && reorder < minQty) reorder = minQty;

      const daysCover = avgDaily > 0 ? (base.on_hand / avgDaily) : (base.on_hand > 0 ? 999 : 0);

      results.push({
        merchant_id: merchantId,
        location_id: locationId,
        variation_id: variationId,
        item_name: base.item_name,
        sku: base.sku,
        gtin: base.gtin,
        on_hand: pctRound(base.on_hand, 2),
        sold_window: pctRound(sold, 2),
        avg_daily_sales: pctRound(avgDaily, 3),
        days_cover: pctRound(daysCover, 1),
        lead_time_days: lead,
        safety_days: safety,
        pack_size: pack,
        min_qty: minQty,
        reorder_qty: pctRound(reorder, 2),
        vendor,
        unit_cost: unitCost,
        est_cost: unitCost != null ? pctRound(unitCost * reorder, 2) : null,
        generated_at: nowIso,
      });
    }

    // sort by lowest days cover, then highest reorder qty
    results.sort((a, b) => (a.days_cover - b.days_cover) || (b.reorder_qty - a.reorder_qty));

    res.json({ ok: true, merchantId, locationId, days, rows: results });
  } catch (e) {
    console.error('reorder error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
