#!/usr/bin/env node
/**
 * scripts/syncSquareSalesLinesToFirestore.js
 * ------------------------------------------------------------
 * Pulls completed Square Orders and writes order line-items into:
 *   merchants/{merchantId}/sales_lines_month/{YYYY-MM}/lines/{orderId}_{idx}
 *
 * Usage:
 *   node scripts/syncSquareSalesLinesToFirestore.js --days 14
 *   node scripts/syncSquareSalesLinesToFirestore.js --merchant ML... --days 30
 *   node scripts/syncSquareSalesLinesToFirestore.js --merchant ML... --start 2025-12-01 --end 2025-12-28
 *   node scripts/syncSquareSalesLinesToFirestore.js --dry-run
 */

require("../lib/loadEnv");
const firestore = require("../lib/firestore");
const { makeCreateSquareClientForMerchant } = require("../lib/square");
const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] || null;
}

const TARGET_MERCHANT_ID = argValue("--merchant") || argValue("-m");
const DAYS = Number(argValue("--days") || "7");
const START = argValue("--start"); // YYYY-MM-DD
const END = argValue("--end");     // YYYY-MM-DD
const DRY_RUN = argv.includes("--dry-run") || argv.includes("--dryrun");

function isoStartOfDay(yyyyMmDd) {
  const x = new Date(yyyyMmDd);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}
function isoEndOfDay(yyyyMmDd) {
  const x = new Date(yyyyMmDd);
  x.setHours(23, 59, 59, 999);
  return x.toISOString();
}
function yyyyMmFromIso(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function moneyAmount(m) {
  if (!m) return 0;
  const a = Number(m.amount);
  return Number.isFinite(a) ? a : 0; // cents
}

async function listAllMerchants() {
  const snap = await firestore.collection("merchants").get();
  return snap.docs.map(d => d.id);
}

async function listLocationIds(squareClient) {
  const locationsApi = squareClient.locationsApi;
  if (!locationsApi?.listLocations) throw new Error("Square client missing locationsApi.listLocations");

  const resp = await locationsApi.listLocations();
  const result = resp?.result || resp || {};
  const locations = result?.locations || [];
  return locations.map(l => l.id).filter(Boolean);
}

/**
 * Search COMPLETED orders for specified locationIds within time range.
 * Uses CLOSED_AT for completed sales (recommended).
 */
async function searchCompletedOrders({ squareClient, locationIds, startAtIso, endAtIso }) {
  const ordersApi = squareClient.ordersApi;
  if (!ordersApi?.searchOrders) throw new Error("Square client missing ordersApi.searchOrders");

  async function runSearch({ sortField, dateTimeFilter }) {
    let cursor = undefined;
    const out = [];

    while (true) {
      const body = {
        locationIds,
        limit: 100,
        cursor,
        query: {
          filter: {
            stateFilter: { states: ["COMPLETED"] },
            dateTimeFilter, // { createdAt: {...} } OR { closedAt: {...} }
          },
          sort: { sortField, sortOrder: "ASC" },
        },
      };

      const resp = await ordersApi.searchOrders(body);
      const result = resp?.result || resp || {};
      const batch = result?.orders || [];
      out.push(...batch);

      cursor = result?.cursor;
      if (!cursor) break;
    }

    return out;
  }

  // 1) Preferred: CLOSED_AT
  const byClosed = await runSearch({
    sortField: "CLOSED_AT",
    dateTimeFilter: { closedAt: { startAt: startAtIso, endAt: endAtIso } },
  });

  // 2) Fallback: CREATED_AT (captures “completed but no closed_at”)
  const byCreated = await runSearch({
    sortField: "CREATED_AT",
    dateTimeFilter: { createdAt: { startAt: startAtIso, endAt: endAtIso } },
  });

  // Merge + dedupe by order id
  const map = new Map();
  for (const o of [...byClosed, ...byCreated]) {
    if (o?.id) map.set(o.id, o);
  }
  const merged = Array.from(map.values());

  // Helpful debug: show returned date span
  const dates = merged
    .map(o => o.closedAt || o.createdAt)
    .filter(Boolean)
    .sort();
  const min = dates[0] || null;
  const max = dates[dates.length - 1] || null;
  console.log(`🧪 Orders merged=${merged.length} closedOnly=${byClosed.length} createdOnly=${byCreated.length} span=${min} → ${max}`);

  return merged;
}


(async function main() {
  console.log("🔥 Using Firestore database:", process.env.APP_ENV || process.env.NODE_ENV || "dev");
  console.log("🧪 DRY_RUN:", DRY_RUN);

  // Determine date range
  let startAtIso, endAtIso;
  if (START && END) {
    startAtIso = isoStartOfDay(START);
    endAtIso = isoEndOfDay(END);
  } else {
    const end = new Date();
    const start = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
    startAtIso = start.toISOString();
    endAtIso = end.toISOString();
  }
  console.log("📅 Range:", startAtIso, "→", endAtIso);

  const merchantIds = TARGET_MERCHANT_ID ? [TARGET_MERCHANT_ID] : await listAllMerchants();
  if (!merchantIds.length) {
    console.log("No merchants found.");
    process.exit(0);
  }

  let totalLines = 0;
  let totalWritten = 0;

  for (const merchantId of merchantIds) {
    console.log("\n==============================");
    console.log("🏪 Merchant:", merchantId);

    let squareClient;
    try {
      squareClient = await createSquareClientForMerchant({ merchantId });
      if (!squareClient) throw new Error("createSquareClientForMerchant returned null");
    } catch (e) {
      console.log("⚠️  Skip merchant (client create failed):", e?.message || e);
      continue;
    }

    let locationIds = [];
    try {
      locationIds = await listLocationIds(squareClient);
    } catch (e) {
      console.log("❌ listLocations failed:", e?.message || e);
      continue;
    }

    if (!locationIds.length) {
      console.log("⚠️  No locations found for merchant. Skipping.");
      continue;
    }

    console.log("📍 Locations:", locationIds.length);

    // Square allows max 10 location_ids per searchOrders
    const locationGroups = chunk(locationIds, 10);

    let orders = [];
    try {
      for (const group of locationGroups) {
        const got = await searchCompletedOrders({
          squareClient,
          locationIds: group,
          startAtIso,
          endAtIso,
        });
        orders.push(...got);
      }
    } catch (e) {
      console.log("❌ searchOrders failed:", e?.message || e);
      continue;
    }

    console.log("📦 Orders:", orders.length);

    const writes = [];

    for (const o of orders) {
      const orderId = o?.id || "";
      const locationId = o?.locationId || o?.location_id || null;

      const createdAt = o?.createdAt || o?.created_at || null;
      const closedAt = o?.closedAt || o?.closed_at || null;

      const currency =
        o?.totalMoney?.currency ||
        o?.total_money?.currency ||
        "USD";

      const month = yyyyMmFromIso(closedAt || createdAt || new Date().toISOString());

      const lines = Array.isArray(o?.lineItems)
        ? o.lineItems
        : (Array.isArray(o?.line_items) ? o.line_items : []);

      lines.forEach((li, idx) => {
        const qty = Number(li?.quantity || li?.qty || 0);
        if (!qty) return;

        const variationId =
          li?.variationId ||
          li?.catalogObjectId ||
          li?.catalog_object_id ||
          null;

        const itemName = li?.name || li?.itemName || li?.item_name || null;
        const variationName = li?.variationName || li?.variation_name || null;

        const gross = moneyAmount(li?.grossSalesMoney || li?.gross_sales_money);
        const net = moneyAmount(li?.totalMoney || li?.total_money);

        const docId = `${orderId}_${idx}`;

        writes.push({
          month,
          docId,
          data: {
            merchant_id: merchantId,
            location_id: locationId,
            order_id: orderId,
            created_at: createdAt,
            closed_at: closedAt,

            item_id: li?.itemId || li?.item_id || null,
            variation_id: variationId,

            // usually not in orders; we’ll join later from inventory
            sku: li?.sku || null,
            gtin: li?.gtin || null,

            item_name: itemName,
            variation_name: variationName,

            qty,
            gross_sales: gross,
            net_sales: net,
            currency,

            updated_at: new Date().toISOString(),
          },
        });
      });
    }

    totalLines += writes.length;
    console.log("🧾 Line items:", writes.length);

    if (DRY_RUN) continue;

    const batches = chunk(writes, 450);
    let written = 0;

    for (const b of batches) {
      const batch = firestore.batch();
      for (const w of b) {
        const ref = firestore
          .collection("merchants").doc(merchantId)
          .collection("sales_lines_month").doc(w.month)
          .collection("lines").doc(w.docId);

        batch.set(ref, w.data, { merge: true });
      }
      await batch.commit();
      written += b.length;
    }

    totalWritten += written;
    console.log("✅ Written:", written);
  }

  console.log("\nDONE ✅");
  console.log("totalLines:", totalLines);
  console.log("totalWritten:", totalWritten);
  process.exit(0);
})().catch((e) => {
  console.error("FATAL ❌", e);
  process.exit(1);
});
