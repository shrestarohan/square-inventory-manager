#!/usr/bin/env node
/**
 * scripts/buildReplenishmentRecommendations.js
 * ------------------------------------------------------------
 * PURPOSE
 *   Build reorder recommendations using:
 *     - Inventory (merchants/{merchantId}/inventory)
 *     - Sales lines (merchants/{merchantId}/sales_lines_month/{YYYY-MM}/lines)
 *
 *   ✅ Fix #2 applied:
 *     - Paged month reads (no giant stream)
 *     - Aggregate sales into Map(variation_id -> qtySold)
 *     - Zero N+1 queries
 *
 * OUTPUT
 *   merchants/{merchantId}/replenishment_recommendations/{variationId}
 *
 * USAGE
 *   node scripts/buildReplenishmentRecommendations.js --merchant ML... --days 84
 *   node scripts/buildReplenishmentRecommendations.js --merchant ML... --days 84 --dry-run
 *
 * OPTIONAL TUNING
 *   --lead 7           lead time days (default 7)
 *   --safety 3         safety stock days (default 3)
 *   --target 21        target coverage days (default 21)
 *   --page 2000        page size for reads (default 2000)
 * ------------------------------------------------------------
 */

require("../lib/loadEnv");
const firestore = require("../lib/firestore");

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] || null;
}

const TARGET_MERCHANT_ID = argValue("--merchant") || argValue("-m");
const DAYS = Number(argValue("--days") || "84");
const DRY_RUN = argv.includes("--dry-run") || argv.includes("--dryrun");

const LEAD_DAYS = Number(argValue("--lead") || "7");
const SAFETY_DAYS = Number(argValue("--safety") || "3");
const TARGET_DAYS = Number(argValue("--target") || "21");

const PAGE_SIZE = Math.min(Math.max(Number(argValue("--page") || "2000"), 200), 5000);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function monthIdsForRange(startIso, endIso) {
  const out = [];
  const start = new Date(startIso);
  const end = new Date(endIso);

  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d <= end) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

async function listAllMerchants() {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map((d) => d.id);
}

/**
 * Read ALL inventory docs for a merchant with paging.
 * Assumes inventory docs represent variations (your project does).
 */
async function readInventoryPaged({ merchantId, pageSize }) {
  const invRef = firestore.collection("merchants").doc(merchantId).collection("inventory");

  const rows = [];
  let last = null;

  while (true) {
    let q = invRef.orderBy("__name__").limit(pageSize);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      rows.push({ id: doc.id, ...d });
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }

  return rows;
}

/**
 * ✅ FIX #2: Read sales lines by month buckets, paging each month collection,
 * and aggregate into Map(variation_id -> qtySold).
 */
async function readAllSalesLinesPaged({ merchantId, monthIds, pageSize }) {
  const countsByVariation = new Map(); // variation_id -> qty
  let totalLines = 0;

  for (const monthId of monthIds) {
    const col = firestore
      .collection("merchants").doc(merchantId)
      .collection("sales_lines_month").doc(monthId)
      .collection("lines");

    console.log("📦 Reading month:", monthId);

    let last = null;
    let processedThisMonth = 0;

    while (true) {
      let q = col.orderBy("__name__").limit(pageSize);
      if (last) q = q.startAfter(last);

      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        const d = doc.data() || {};
        const vid = d.variation_id || d.variationId || null;
        const qty = safeNum(d.qty);

        if (!vid || qty <= 0) continue;

        countsByVariation.set(vid, (countsByVariation.get(vid) || 0) + qty);
        processedThisMonth++;
      }

      totalLines += snap.size;
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }

    console.log(`✅ Month ${monthId}: aggregated variations=${countsByVariation.size}, processedValidLines=${processedThisMonth}`);
  }

  return { countsByVariation, totalLines };
}

/**
 * Compute reorder recommendations
 * - avgDaily = qtySold / daysWindow
 * - reorderPoint = avgDaily * (lead + safety)
 * - targetStock = avgDaily * targetDays
 * - recommendedOrder = max(0, ceil(targetStock - onHand))
 */
function computeRecommendations({ inventoryRows, countsByVariation, daysWindow }) {
  const recs = [];

  for (const r of inventoryRows) {
    // Variation id is key for joining sales lines
    const variationId = (r.variation_id || r.variationId || "").toString().trim();
    if (!variationId) continue;

    const sold = safeNum(countsByVariation.get(variationId) || 0);
    const avgDaily = sold / Math.max(1, daysWindow);

    // your inventory qty might be in qty, quantity, or computed field
    const onHand = safeNum(r.qty ?? r.quantity ?? r.on_hand ?? 0);

    const reorderPoint = avgDaily * (LEAD_DAYS + SAFETY_DAYS);
    const targetStock = avgDaily * TARGET_DAYS;

    const need = Math.max(0, Math.ceil(targetStock - onHand));

    // Keep rows even if need=0? Up to you. We'll keep only actionable ones.
    if (need <= 0) continue;

    recs.push({
      variation_id: variationId,
      item_id: r.item_id || null,
      merchant_id: r.merchant_id || null,

      sku: r.sku || null,
      gtin: r.gtin || null,

      item_name: r.item_name || r.name || null,
      variation_name: r.variation_name || null,

      on_hand: onHand,
      sold_qty: sold,
      avg_daily_sold: Number(avgDaily.toFixed(4)),

      reorder_point: Number(reorderPoint.toFixed(2)),
      target_stock: Number(targetStock.toFixed(2)),
      recommended_order_qty: need,

      // optional: price/cost if you store it
      price: r.price ?? null,
      unit_cost: r.unit_cost ?? r.cost ?? null,
    });
  }

  // Sort most urgent first: (targetStock - onHand) descending
  recs.sort((a, b) => (b.target_stock - b.on_hand) - (a.target_stock - a.on_hand));
  return recs;
}

async function writeRecommendations({ merchantId, recs, pageSize }) {
  const col = firestore.collection("merchants").doc(merchantId).collection("replenishment_recommendations");
  const ts = nowIso();

  const writes = recs.map((r) => {
    const docId = r.variation_id;
    return {
      docId,
      data: {
        ...r,
        lead_days: LEAD_DAYS,
        safety_days: SAFETY_DAYS,
        target_days: TARGET_DAYS,
        updated_at: ts,
      },
    };
  });

  const batches = chunk(writes, 450);
  let written = 0;

  for (const b of batches) {
    const batch = firestore.batch();
    for (const w of b) {
      batch.set(col.doc(w.docId), w.data, { merge: true });
    }
    await batch.commit();
    written += b.length;
  }

  return written;
}

(async function main() {
  console.log("🔥 Using Firestore database:", process.env.APP_ENV || process.env.NODE_ENV || "dev");
  console.log("🔥 DB:", process.env.APP_ENV || process.env.NODE_ENV || "dev");
  console.log("🧪 DRY_RUN:", DRY_RUN);
  console.log("📆 DAYS:", DAYS);
  console.log("⚙️ lead/safety/target:", LEAD_DAYS, SAFETY_DAYS, TARGET_DAYS);
  console.log("📄 PAGE_SIZE:", PAGE_SIZE);

  // Time range
  const end = new Date();
  const start = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const monthIds = monthIdsForRange(startIso, endIso);
  console.log("🗓️ Months in range:", monthIds.join(", "));

  const merchantIds = TARGET_MERCHANT_ID ? [TARGET_MERCHANT_ID] : await listAllMerchants();

  let totalWritten = 0;

  for (const merchantId of merchantIds) {
    console.log("\n==============================");
    console.log("🏪 Merchant:", merchantId);

    // 1) Inventory (paged)
    const inventoryRows = await readInventoryPaged({ merchantId, pageSize: PAGE_SIZE });
    console.log("📦 Inventory variations:", inventoryRows.length);

    // 2) Sales lines (paged by month + aggregate)
    const { countsByVariation, totalLines } = await readAllSalesLinesPaged({
      merchantId,
      monthIds,
      pageSize: PAGE_SIZE,
    });

    console.log("🧾 Sales line docs scanned:", totalLines);
    console.log("🧾 Variations with sales:", countsByVariation.size);

    // 3) Recommendations
    const recs = computeRecommendations({
      inventoryRows,
      countsByVariation,
      daysWindow: DAYS,
    });

    console.log("🧠 Recommendations computed:", recs.length);

    if (DRY_RUN) {
      // Show a small sample so you can sanity-check
      console.log("🧪 DRY_RUN sample:", recs.slice(0, 5));
      continue;
    }

    // 4) Write
    const written = await writeRecommendations({ merchantId, recs, pageSize: PAGE_SIZE });
    totalWritten += written;
    console.log("✅ Written:", written);
  }

  console.log("\nDONE ✅");
  console.log("totalWritten:", totalWritten);
  process.exit(0);
})().catch((err) => {
  console.error("FATAL ❌", err);
  process.exit(1);
});
