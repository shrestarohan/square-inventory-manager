// services/negativeInventoryService.js
const { FieldValue } = require('@google-cloud/firestore');

function classifyNegative({ qty, lastSyncAt, updatedAt }) {
  // "AI" layer v1 = deterministic rules (fast, reliable)
  // You can later swap/augment this with an LLM.
  const now = Date.now();
  const lastSyncMs = lastSyncAt?.toMillis ? lastSyncAt.toMillis() : null;
  const updatedMs = updatedAt?.toMillis ? updatedAt.toMillis() : null;

  const staleSyncHours = lastSyncMs ? (now - lastSyncMs) / (1000 * 60 * 60) : null;
  const updatedHours = updatedMs ? (now - updatedMs) / (1000 * 60 * 60) : null;

  if (qty >= 0) {
    return { root_cause: null, confidence: 0, suggested_action: null, risk: "none" };
  }

  if (staleSyncHours != null && staleSyncHours > 6) {
    return {
      root_cause: "Likely delayed/missed inventory sync",
      confidence: 0.8,
      suggested_action: "RESYNC_SQUARE",
      risk: "low",
    };
  }

  if (updatedHours != null && updatedHours < 4) {
    return {
      root_cause: "Likely oversold vs. current stock",
      confidence: 0.75,
      suggested_action: "ADJUST_TO_ZERO",
      risk: "low",
    };
  }

  return {
    root_cause: "Needs review: possible wrong location, seeding error, or manual adjustment",
    confidence: 0.55,
    suggested_action: "ADJUST_TO_ZERO",
    risk: "medium",
  };
}

async function listNegatives({ firestore, merchantId = null, limit = 200, q = '' }) {
  let colRef = merchantId
    ? firestore.collection('merchants').doc(merchantId).collection('inventory')
    : firestore.collection('inventory');

  const snap = await colRef.where('qty', '<', 0).limit(limit).get();

  const qNorm = (q || '').toString().trim().toLowerCase().replace(/\s+/g, '');

  let rows = snap.docs.map((d) => {
    const data = d.data();
    const ai = classifyNegative({
      qty: data.qty,
      lastSyncAt: data.last_sync_at,
      updatedAt: data.updated_at || data.updatedAt,
    });

    return {
      id: d.id,
      merchant_id: data.merchant_id || merchantId || null,
      location_id: data.location_id || null,
      location_name: data.location_name || null,
      item_id: data.item_id || null,
      variation_id: data.variation_id || null,
      gtin: data.gtin || null,
      name: data.name || data.item_name || data.canonical_name || null,
      sku: data.sku || null,
      qty: data.qty,
      last_sync_at: data.last_sync_at || null,
      updated_at: data.updated_at || data.updatedAt || null,
      ai,
    };
  });

  // ✅ in-memory search (no new indexes)
  if (qNorm) {
    rows = rows.filter(r => {
      const hay = [
        r.name, r.sku, r.gtin, r.location_name, r.location_id, r.merchant_id
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, '');
      return hay.includes(qNorm);
    });
  }

  return rows;
}


async function writeFixAudit({ firestore, payload }) {
  await firestore.collection('inventory_fixes').add({
    ...payload,
    created_at: FieldValue.serverTimestamp(),
  });
}

module.exports = { listNegatives, writeFixAudit };
