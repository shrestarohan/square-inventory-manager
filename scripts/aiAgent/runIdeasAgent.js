/**
 * Nightly Liquor Store Ideas Agent
 * - Pulls Square data (sales + inventory/cost)
 * - Merges with Firestore if enabled
 * - Computes signals
 * - Generates + ranks ideas using LLM
 * - Posts to Slack + stores run in Firestore
 */

require('dotenv').config();

const crypto = require('crypto');
const { Firestore } = require('@google-cloud/firestore');
const fetch = require('node-fetch');
const { Client, Environment } = require('square/legacy');

const firestore = new Firestore();

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function nowIso() {
  return new Date().toISOString();
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function storeKey(merchantId, locationId) {
  return `${merchantId}|${locationId}`;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** -------------------------
 *  Square client
 *  ------------------------- */
function getSquareClient() {
  const env = (process.env.SQUARE_ENV || 'production').toLowerCase();
  const environment = env === 'sandbox' ? Environment.Sandbox : Environment.Production;
  return new Client({ environment, accessToken: mustEnv('SQUARE_ACCESS_TOKEN') });
}

/** -------------------------
 *  Data collection
 *  ------------------------- */

// Minimal catalog pull (items/variations + cost if present in your system)
async function fetchCatalog(client) {
  // You can tune this to your existing inventory sync dataset instead.
  // Here: list catalog objects of type ITEM and ITEM_VARIATION
  const types = 'ITEM,ITEM_VARIATION';
  let cursor = undefined;
  const objects = [];

  for (let i = 0; i < 200; i++) { // safety
    const resp = await client.catalogApi.listCatalog(undefined, types, cursor);
    const body = resp.result || resp;
    if (body.objects) objects.push(...body.objects);
    cursor = body.cursor;
    if (!cursor) break;
  }
  return objects;
}

// Pull inventory counts for locations (Square Inventory API)
async function fetchInventoryCounts(client, locationIds) {
  // Batch retrieve counts for all items for given locations
  // NOTE: Square inventory endpoints can be large; you can switch to using your Firestore inventory snapshot.
  const counts = [];
  let cursor = undefined;

  for (let i = 0; i < 200; i++) {
    const resp = await client.inventoryApi.batchRetrieveInventoryCounts({
      locationIds,
      cursor,
      // You can filter by states: IN_STOCK, SOLD, RETURNED, etc.
      states: ['IN_STOCK'],
    });
    const body = resp.result || resp;
    if (body.counts) counts.push(...body.counts);
    cursor = body.cursor;
    if (!cursor) break;
  }
  return counts;
}

// Pull recent orders for sales signals (Square Orders API)
async function fetchRecentOrders(client, locationId, windowDays) {
  const orders = [];
  let cursor = undefined;

  const startAt = daysAgoISO(windowDays);

  for (let i = 0; i < 200; i++) {
    const resp = await client.ordersApi.searchOrders({
      locationIds: [locationId],
      cursor,
      query: {
        filter: {
          dateTimeFilter: {
            createdAt: { startAt }
          },
          stateFilter: { states: ['COMPLETED'] }
        },
        sort: { sortField: 'CREATED_AT', sortOrder: 'DESC' }
      },
      limit: 500
    });
    const body = resp.result || resp;
    if (body.orders) orders.push(...body.orders);
    cursor = body.cursor;
    if (!cursor) break;
  }
  return orders;
}

/** -------------------------
 *  Firestore merge (optional)
 *  ------------------------- */
async function loadFirestoreGtinMatrixSample(limit = 2000) {
  // If you already have a gtin_matrix collection, we can use it to avoid heavy Square inventory pulls.
  // This function returns a sample / subset; you can replace with your own query logic.
  const snap = await firestore.collection('gtin_matrix').limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** -------------------------
 *  Signals
 *  ------------------------- */
function computeSignals({ store, catalogObjects, inventoryCounts, orders, windowDays }) {
  // Build lookup: variationId -> item metadata
  const variationToItem = new Map();
  const itemMeta = new Map(); // itemId -> {name, category, gtin, sku}
  for (const obj of catalogObjects) {
    if (obj.type === 'ITEM') {
      const itemId = obj.id;
      const name = obj.itemData?.name || 'Unknown';
      const categoryId = obj.itemData?.categoryId || null;
      itemMeta.set(itemId, { name, categoryId });
      const variations = obj.itemData?.variations || [];
      for (const v of variations) {
        const variationId = v.id;
        const sku = v.itemVariationData?.sku || null;
        const gtin = v.itemVariationData?.upc || null; // Square uses UPC; you treat as GTIN/UPC
        const priceMoney = v.itemVariationData?.priceMoney || null;
        variationToItem.set(variationId, {
          itemId,
          name,
          categoryId,
          sku,
          gtin,
          price: priceMoney ? safeNum(priceMoney.amount) / 100 : null,
          currency: priceMoney?.currency || 'USD'
        });
      }
    }
  }

  // Inventory: variationId -> qty
  const onHand = new Map();
  for (const c of inventoryCounts) {
    const vId = c.catalogObjectId;
    const qty = safeNum(c.quantity);
    onHand.set(vId, (onHand.get(vId) || 0) + qty);
  }

  // Sales: variationId -> units + revenue
  const sales = new Map();
  for (const o of orders) {
    const lines = o.lineItems || [];
    for (const li of lines) {
      const vId = li.catalogObjectId;
      if (!vId) continue;
      const qty = safeNum(li.quantity);
      const gross = li.grossSalesMoney ? safeNum(li.grossSalesMoney.amount) / 100 : 0;
      const key = vId;
      const prev = sales.get(key) || { units: 0, gross: 0, orders: 0 };
      prev.units += qty;
      prev.gross += gross;
      prev.orders += 1;
      sales.set(key, prev);
    }
  }

  // Assemble rows
  const rows = [];
  for (const [variationId, meta] of variationToItem.entries()) {
    const s = sales.get(variationId) || { units: 0, gross: 0, orders: 0 };
    const qty = onHand.get(variationId) ?? null;
    const unitsPerDay = windowDays > 0 ? s.units / windowDays : 0;
    const daysOfSupply = (qty != null && unitsPerDay > 0) ? qty / unitsPerDay : null;

    rows.push({
      variation_id: variationId,
      item_id: meta.itemId,
      name: meta.name,
      category_id: meta.categoryId,
      sku: meta.sku,
      gtin: meta.gtin,
      price: meta.price,
      currency: meta.currency,
      on_hand: qty,
      units_sold: s.units,
      gross_sales: s.gross,
      units_per_day: unitsPerDay,
      days_of_supply: daysOfSupply
    });
  }

  // Signals
  const winners = [...rows]
    .filter(r => r.units_sold >= 8)
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 30);

  const deadStock = [...rows]
    .filter(r => (r.on_hand ?? 0) >= 6 && r.units_sold <= 1)
    .sort((a, b) => (b.on_hand ?? 0) - (a.on_hand ?? 0))
    .slice(0, 40);

  const stockoutRisk = [...rows]
    .filter(r => r.units_per_day >= 0.5 && (r.on_hand ?? 0) <= 4)
    .sort((a, b) => b.units_per_day - a.units_per_day)
    .slice(0, 30);

  return {
    store,
    summary: {
      total_skus_seen: rows.length,
      winners_count: winners.length,
      dead_stock_count: deadStock.length,
      stockout_risk_count: stockoutRisk.length,
      window_days: windowDays
    },
    winners,
    deadStock,
    stockoutRisk
  };
}

/** -------------------------
 *  LLM calls (generate + rank)
 *  ------------------------- */
async function callLLM({ system, user }) {
  // Minimal OpenAI-compatible call (no SDK needed)
  const apiKey = mustEnv('OPENAI_API_KEY');
  const model = process.env.OPENAI_MODEL || 'gpt-5.2-thinking';

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.4
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`LLM error ${resp.status}: ${t}`);
  }
  const json = await resp.json();
  return json.choices?.[0]?.message?.content || '';
}

function buildIdeaPrompt({ signals, ideaCount }) {
  const { store, summary, winners, deadStock, stockoutRisk } = signals;

  // Keep prompt small: top slices only
  const topWinners = winners.slice(0, 12).map(x => ({
    name: x.name, gtin: x.gtin, sku: x.sku, on_hand: x.on_hand, units_sold: x.units_sold, price: x.price
  }));
  const topDead = deadStock.slice(0, 12).map(x => ({
    name: x.name, gtin: x.gtin, sku: x.sku, on_hand: x.on_hand, units_sold: x.units_sold, price: x.price
  }));
  const topRisk = stockoutRisk.slice(0, 12).map(x => ({
    name: x.name, gtin: x.gtin, sku: x.sku, on_hand: x.on_hand, units_per_day: x.units_per_day, price: x.price
  }));

  return `
Store: ${store.merchant_name} (${store.location_name})
Window days: ${summary.window_days}
High-level: total_skus_seen=${summary.total_skus_seen}

Top Winners (sell-through):
${JSON.stringify(topWinners, null, 2)}

Dead Stock (high on-hand, low sales):
${JSON.stringify(topDead, null, 2)}

Stockout Risk (fast sellers, low on-hand):
${JSON.stringify(topRisk, null, 2)}

Constraints:
- Keep ideas legal and compliant with alcohol regulations; no underage targeting.
- Prefer ideas that increase PROFIT (not only revenue).
- Provide concrete steps: what to change in Square, signage, bundle rules, reorder actions.
- Provide measurement plan (KPIs) and a 7–14 day experiment plan.

Task:
Generate exactly ${ideaCount} business ideas. Output ONLY valid JSON in this schema:

{
  "ideas": [
    {
      "id": "string-short",
      "title": "string",
      "why_it_fits": "string",
      "expected_impact": {
        "profit_weekly_usd": number,
        "revenue_weekly_usd": number,
        "inventory_turn_improvement": "string"
      },
      "effort": "low|medium|high",
      "cost_estimate_usd": number,
      "execution_steps": ["step1", "step2", ...],
      "risks": ["..."],
      "success_metrics": ["..."]
    }
  ]
}
`.trim();
}

function buildRankPrompt({ rawIdeasJson }) {
  return `
You are a strict business operator for a liquor store.
Rank and score these ideas by expected PROFIT impact, feasibility, and speed to implement.
Remove any ideas that are generic, illegal, unclear, or not measurable.

Output ONLY valid JSON:

{
  "ideas": [
    {
      "id": "string-short",
      "title": "string",
      "score": number,  // 0-100
      "why_top": "string",
      "expected_impact": { "profit_weekly_usd": number, "revenue_weekly_usd": number, "inventory_turn_improvement": "string" },
      "effort": "low|medium|high",
      "cost_estimate_usd": number,
      "execution_steps": ["..."],
      "risks": ["..."],
      "success_metrics": ["..."]
    }
  ]
}
`.trim() + `\n\nIDEAS_JSON:\n${rawIdeasJson}`;
}

function parseJsonStrict(text) {
  // Attempt to extract first JSON block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM did not return JSON');
  const jsonText = text.slice(start, end + 1);
  return JSON.parse(jsonText);
}

/** -------------------------
 *  Slack posting
 *  ------------------------- */
async function postToSlack({ title, ideas, storeLabel }) {
  const url = mustEnv('SLACK_WEBHOOK_URL');
  const lines = ideas.slice(0, 10).map((x, i) => {
    const profit = x.expected_impact?.profit_weekly_usd ?? 0;
    return `*${i + 1}. ${x.title}* (Score ${x.score}/100) — est profit/wk: $${profit}\n• ${x.why_top || x.why_it_fits}`;
  });

  const payload = {
    text: `🧠 *AI Ideas Agent* — ${storeLabel}\n*${title}*\n\n${lines.join('\n\n')}`
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Slack webhook error ${resp.status}: ${t}`);
  }
}

/** -------------------------
 *  Main
 *  ------------------------- */
async function run() {
  const runId = crypto.randomUUID();
  const createdAt = nowIso();

  const windowDays = Number(process.env.WINDOW_DAYS || 28);
  const ideaCount = Number(process.env.IDEA_COUNT || 10);

  const useSquare = (process.env.USE_SQUARE_API || 'true') === 'true';
  const useFirestoreCache = (process.env.USE_FIRESTORE_CACHE || 'true') === 'true';

  const squareClient = useSquare ? getSquareClient() : null;

  const runDocRef = firestore.collection('ai_agent_runs').doc(runId);

  try {
    // Discover locations: you can also hardcode from env
    let locationIds = (process.env.SQUARE_LOCATION_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    let locations = [];
    if (useSquare) {
      const locResp = await squareClient.locationsApi.listLocations();
      const body = locResp.result || locResp;
      locations = body.locations || [];
      if (locationIds.length === 0) {
        locationIds = locations.map(l => l.id);
      }
    }

    // Optional Firestore matrix sample (not required for MVP)
    let fsMatrixSample = null;
    if (useFirestoreCache) {
      try {
        fsMatrixSample = await loadFirestoreGtinMatrixSample(500);
      } catch (e) {
        // non-fatal
        fsMatrixSample = null;
      }
    }

    // Shared catalog + inventory (can be heavy; optimize later with Firestore snapshots)
    const catalogObjects = useSquare ? await fetchCatalog(squareClient) : [];
    const inventoryCounts = useSquare ? await fetchInventoryCounts(squareClient, locationIds) : [];

    const storeRuns = [];
    for (const locId of locationIds) {
      const loc = locations.find(x => x.id === locId) || { id: locId, name: locId };
      const store = {
        merchant_id: 'default',               // Square legacy client is single merchant token; keep placeholder
        location_id: locId,
        merchant_name: 'SquareAccount',
        location_name: loc.name || locId
      };

      const orders = useSquare ? await fetchRecentOrders(squareClient, locId, windowDays) : [];
      const signals = computeSignals({ store, catalogObjects, inventoryCounts, orders, windowDays });

      // Build prompt, generate ideas, rank ideas
      const system = `You are a pragmatic liquor store operator and growth strategist. Produce specific, measurable actions.`;
      const userPrompt = buildIdeaPrompt({ signals, ideaCount });

      const raw = await callLLM({ system, user: userPrompt });
      const rawJson = parseJsonStrict(raw);

      const rankedRaw = await callLLM({
        system: `You are a strict evaluator. Output ONLY JSON. No prose.`,
        user: buildRankPrompt({ rawIdeasJson: JSON.stringify(rawJson) })
      });

      const ranked = parseJsonStrict(rankedRaw);

      // Save + Slack
      await postToSlack({
        title: `Top ideas (last ${windowDays} days)`,
        ideas: ranked.ideas || [],
        storeLabel: `${store.location_name}`
      });

      storeRuns.push({
        store,
        signals_summary: signals.summary,
        ideas: ranked.ideas || [],
        fs_matrix_sample_used: !!fsMatrixSample
      });
    }

    const inputSummary = {
      window_days: windowDays,
      store_count: storeRuns.length,
      use_square_api: useSquare,
      use_firestore_cache: useFirestoreCache
    };

    await runDocRef.set({
      run_id: runId,
      created_at: createdAt,
      input_summary: inputSummary,
      stores: storeRuns.map(s => s.store),
      results: storeRuns,
      model: process.env.OPENAI_MODEL || null,
      status: 'success'
    });

    console.log(`✅ AI Ideas Agent success. runId=${runId}`);
    return { ok: true, runId };
  } catch (err) {
    console.error('❌ AI Ideas Agent failed:', err);

    await runDocRef.set({
      run_id: runId,
      created_at: createdAt,
      status: 'error',
      error: { message: String(err.message || err), stack: String(err.stack || '') }
    }, { merge: true });

    process.exitCode = 1;
    return { ok: false, runId, error: String(err.message || err) };
  }
}

if (require.main === module) {
  run();
}

module.exports = { run };
