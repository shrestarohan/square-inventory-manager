// routes/replenishmentAiApi.js
const express = require("express");
const OpenAI = require("openai");

/**
 * Replenishment + Audit API (context-safe)
 * ---------------------------------------
 * Endpoints:
 *   POST /api/replenishment-ai/plan
 *     body: { merchantId, days?, budget?, targetDays?, maxLines?, candidateCap?, notes? }
 *
 *   POST /api/replenishment-ai/audit
 *     body: {
 *       merchantId,
 *       days?,
 *       notes?,
 *       includeTopSellers?,
 *       includeZeroOrNegative?,
 *       includeRemovalCandidates?
 *     }
 *
 * Snapshot builds:
 *   - topSellers (sold>0)
 *   - zeroOrNegative (on_hand<=0)
 *   - removalCandidates (sold==0)
 *
 * Plan uses a SERVER-SIDE filtered + slimmed "candidates[]" list to avoid
 * OpenAI context-window errors. It also includes stockouts (zero/negative)
 * and reorders based on target DOS & velocity.
 */
module.exports = function buildReplenishmentAiApiRouter({ firestore, requireLogin }) {
  const router = express.Router();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ---------------------------
  // Utils
  // ---------------------------
  function nowIso() {
    return new Date().toISOString();
  }

  // ✅ safeNum: convert any value to a finite number or 0
  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function clampInt(n, min, max, fallback) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(x)));
  }

  function isQuota429(err) {
    const msg = (err?.message || "").toLowerCase();
    return msg.includes("exceeded your current quota") || err?.status === 429;
  }

  function extractOutputText(resp) {
    const outText =
      resp?.output_text ||
      (Array.isArray(resp?.output)
        ? resp.output
            .flatMap((o) => o.content || [])
            .map((c) => c?.text)
            .filter(Boolean)
            .join("\n")
        : "");
    return (outText || "").toString().trim();
  }

  function safeJsonParse(text) {
    const raw = (text || "").trim();
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (e1) {
      // salvage: slice from first { to last }
      const a = raw.indexOf("{");
      const b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) {
        const sliced = raw.slice(a, b + 1);
        try {
          return { ok: true, value: JSON.parse(sliced) };
        } catch (e2) {
          return { ok: false, error: e2, raw: raw.slice(0, 8000) };
        }
      }
      return { ok: false, error: e1, raw: raw.slice(0, 8000) };
    }
  }

  function monthIdsForRange(startDate, endDate) {
    const out = [];
    const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    while (d <= endDate) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      out.push(`${y}-${m}`);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
  }

  function estUnitCost(row) {
    const c = safeNum(row.unit_cost);
    if (c > 0) return c;
    const p = safeNum(row.price);
    return p > 0 ? p * 0.6 : 0;
  }

  function computeSuggestedQty(row, targetDays) {
    const avg = safeNum(row.avg_daily_units);
    const onHand = safeNum(row.on_hand);
    if (avg <= 0) return 0;

    const need = Math.ceil(avg * targetDays - onHand);
    return Math.max(0, Math.min(need, 48)); // cap per line
  }

  // server-side gating to keep candidates list relevant + small
  function shouldConsiderForOrder(row, targetDays) {
    const sold = safeNum(row.sold_units);
    const avg = safeNum(row.avg_daily_units);
    const onHand = safeNum(row.on_hand);
    const dos = row.days_of_supply == null ? null : safeNum(row.days_of_supply);

    // Stockouts that have any sales/velocity signal
    if (onHand <= 0 && (sold > 0 || avg > 0)) return true;

    // Fast movers / low DOS
    if (avg >= 0.05 && dos != null && dos <= targetDays * 1.2) return true;

    // Sold in period (some velocity) and low-ish DOS
    if (sold >= 2 && (dos == null || dos <= targetDays * 1.5)) return true;

    return false;
  }

  async function callOpenAIJson({ system, userObj }) {
    const openaiModel = process.env.OPENAI_MODEL || "gpt-5-mini";

    const resp = await client.responses.create({
      model: openaiModel,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userObj) },
      ],
      reasoning: { effort: "minimal" },
      text: { verbosity: "low" },
    });

    const outText = extractOutputText(resp);
    const parsed = safeJsonParse(outText);

    if (!parsed.ok) {
      console.error("AI returned non-JSON:", (parsed.raw || "").slice(0, 2000));
      const err = new Error("AI did not return valid JSON.");
      err.raw = parsed.raw;
      throw err;
    }

    return parsed.value;
  }

  // ---------------------------
  // Snapshot builder
  // ---------------------------
  async function buildSnapshot({
    merchantId,
    days = 84,

    limitTop = 700,
    limitZero = 900,
    limitRemoval = 900,

    includeTopSellers = true,
    includeZeroOrNegative = true,
    includeRemovalCandidates = true,
  }) {
    const end = new Date();
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const monthIds = monthIdsForRange(start, end);

    // Aggregate sales by variation_id
    const soldByVar = new Map();
    const revenueByVar = new Map();

    // Page through monthly line collections
    const PAGE = 2000;
    for (const monthId of monthIds) {
      const col = firestore
        .collection("merchants")
        .doc(merchantId)
        .collection("sales_lines_month")
        .doc(monthId)
        .collection("lines");

      let last = null;
      while (true) {
        let q = col.orderBy("__name__").limit(PAGE);
        if (last) q = q.startAfter(last);

        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
          const d = doc.data() || {};
          const vid = d.variation_id || d.variationId || null;
          if (!vid) continue;

          const qty = safeNum(d.qty ?? d.quantity ?? 0);
          const gross = safeNum(d.gross_sales ?? d.gross ?? d.total ?? d.amount ?? 0);

          if (qty > 0) soldByVar.set(vid, (soldByVar.get(vid) || 0) + qty);
          if (gross > 0) revenueByVar.set(vid, (revenueByVar.get(vid) || 0) + gross);
        }

        last = snap.docs[snap.docs.length - 1];
        if (snap.size < PAGE) break;
      }
    }

    // Inventory scan (one shot). If huge, we can page it later.
    const invRef = firestore.collection("merchants").doc(merchantId).collection("inventory");
    const invSnap = await invRef.get();

    const rowsTop = [];
    const rowsZero = [];
    const rowsRemove = [];

    for (const doc of invSnap.docs) {
      const d = doc.data() || {};
      const vid = (d.variation_id || d.variationId || "").toString().trim();
      if (!vid) continue;

      const onHand = safeNum(d.qty ?? d.quantity ?? d.on_hand ?? d.onHand ?? 0);
      const sold = safeNum(soldByVar.get(vid) || 0);
      const revenue = safeNum(revenueByVar.get(vid) || 0);

      const avgDaily = sold / Math.max(1, days);
      const dos = avgDaily > 0 ? onHand / avgDaily : null;

      const base = {
        variation_id: vid,
        item_id: d.item_id || d.itemId || null,
        sku: d.sku || null,
        gtin: d.gtin || null,
        item_name: d.item_name || d.itemName || null,
        variation_name: d.variation_name || d.variationName || null,
        category_name: d.category_name || d.categoryName || null,
        vendor: d.vendor || d.vendor_name || d.vendorName || null,
        unit_cost: d.unit_cost ?? d.cost ?? d.unitCost ?? null,
        price: d.price ?? null,

        on_hand: onHand,
        sold_units: sold,
        revenue,
        avg_daily_units: Number(avgDaily.toFixed(4)),
        days_of_supply: dos === null ? null : Number(dos.toFixed(1)),
      };

      if (includeTopSellers && sold > 0) rowsTop.push(base);
      if (includeZeroOrNegative && onHand <= 0) rowsZero.push(base);
      if (includeRemovalCandidates && sold <= 0) rowsRemove.push(base);
    }

    if (includeTopSellers) rowsTop.sort((a, b) => b.sold_units - a.sold_units);
    if (includeZeroOrNegative) {
      rowsZero.sort(
        (a, b) =>
          (b.sold_units - a.sold_units) ||
          String(a.item_name || "").localeCompare(String(b.item_name || ""))
      );
    }
    if (includeRemovalCandidates) {
      rowsRemove.sort(
        (a, b) =>
          (b.on_hand - a.on_hand) ||
          String(a.category_name || "").localeCompare(String(b.category_name || "")) ||
          String(a.item_name || "").localeCompare(String(b.item_name || ""))
      );
    }

    const topSellers = includeTopSellers ? rowsTop.slice(0, limitTop) : [];
    const zeroOrNegative = includeZeroOrNegative ? rowsZero.slice(0, limitZero) : [];
    const removalCandidates = includeRemovalCandidates ? rowsRemove.slice(0, limitRemoval) : [];

    return {
      merchantId,
      range: { days, start: start.toISOString(), end: end.toISOString() },
      counts: {
        inventoryDocs: invSnap.size,
        soldVariations: rowsTop.length,
        topSellers: topSellers.length,
        zeroOrNegative: rowsZero.length,
        removalCandidates: rowsRemove.length,
      },
      topSellers,
      zeroOrNegative,
      removalCandidates,
    };
  }

  // ---------------------------
  // Prompts
  // ---------------------------
  function planSystemPrompt() {
    return `
You are a replenishment planner for a liquor store.
Return ONLY valid JSON matching the schema. No markdown. No commentary.

You will receive candidates[] already filtered to reorder-worthy items.
Your job is to:
- Choose which candidates to order and what qty.
- Group by vendor.
- Return as many lines as needed up to maxLines.

Hard requirements:
- If budget is null: return a COMPLETE order list of all items that should be reordered (up to maxLines).
- If budget is provided: include as many lines as possible while staying within budget.
- Do not return fewer than 50 lines unless candidates[] truly contains fewer than 50 order-worthy items.

Qty guidance:
- Prefer using suggested_qty if > 0.
- If suggested_qty is 0 but the item is a stockout with nonzero avg_daily_units, set qty to at least 1.
- Cap any single line qty at 48 unless notes justify.

Cost estimation:
- unit_cost_est is provided; if 0, still include the line if it's critical, but add to watchlist.

JSON schema:
{
  "summary": {
    "merchantId": string,
    "days": number,
    "targetDays": number,
    "budget": number|null,
    "maxLines": number,
    "estimatedTotalCost": number,
    "lineCount": number
  },
  "vendorBuckets": [
    {
      "vendor": string,
      "estimatedCost": number,
      "poLines": [
        {
          "variation_id": string,
          "sku": string|null,
          "gtin": string|null,
          "item_name": string|null,
          "qty": number,
          "unit_cost_est": number,
          "reason": string
        }
      ]
    }
  ],
  "watchlist": [
    { "variation_id": string, "item_name": string|null, "reason": string }
  ]
}
`.trim();
  }

  function auditSystemPrompt() {
    return `
You are an inventory auditor for a liquor store.
Return ONLY valid JSON matching the schema. No markdown. No commentary outside JSON.

Goals:
1) Review items with on_hand <= 0 and rate whether they should be ordered now.
2) Recommend items to remove/deactivate/clearance based on no sales in the last period.

Guidelines:
- For on_hand <= 0:
  - If avg_daily_units is high or sold_units is meaningful, recommend ORDER_NOW.
  - If sold_units is 0 in the period, generally DO_NOT_ORDER unless notes justify.
  - Use INVESTIGATE if data is ambiguous (missing cost/price/category, or weird GTIN/SKU).
- For removal candidates (sold_units == 0):
  - If on_hand > 0, recommend CLEARANCE or RETURN_TO_VENDOR if vendor exists.
  - If on_hand == 0 and sold_units == 0, recommend DEACTIVATE (unless notes justify).
  - Do NOT recommend removing core fast movers; use KEEP/INVESTIGATE if unsure.

Return up to:
- 250 items in zeroOnHandRatings
- 250 items in removeOrDeactivate

JSON schema:
{
  "summary": {
    "merchantId": string,
    "days": number,
    "generatedAt": string,
    "zeroCount": number,
    "removeCandidateCount": number
  },
  "zeroOnHandRatings": [
    {
      "variation_id": string,
      "sku": string|null,
      "gtin": string|null,
      "item_name": string|null,
      "category_name": string|null,
      "vendor": string|null,
      "on_hand": number,
      "sold_units": number,
      "avg_daily_units": number,
      "days_of_supply": number|null,
      "score_order_now": number,
      "recommendation": "ORDER_NOW"|"HOLD"|"DO_NOT_ORDER"|"INVESTIGATE",
      "suggested_qty": number,
      "unit_cost_est": number,
      "reason": string
    }
  ],
  "removeOrDeactivate": [
    {
      "variation_id": string,
      "sku": string|null,
      "gtin": string|null,
      "item_name": string|null,
      "category_name": string|null,
      "vendor": string|null,
      "on_hand": number,
      "sold_units": number,
      "action": "DEACTIVATE"|"CLEARANCE"|"RETURN_TO_VENDOR"|"KEEP"|"INVESTIGATE",
      "confidence": number,
      "reason": string
    }
  ]
}
`.trim();
  }

  // ---------------------------
  // Routes
  // ---------------------------

  /**
   * POST /api/replenishment-ai/plan
   * body: { merchantId, days?, budget?, targetDays?, maxLines?, candidateCap?, notes? }
   *
   * ✅ Context-safe: sends slimmed candidates[] instead of huge raw snapshots.
   */
  router.post("/api/replenishment-ai/plan", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.body?.merchantId || "").toString().trim().replace(/^\/+/, "");
      if (!merchantId) return res.status(400).json({ ok: false, error: "Missing merchantId" });

      const days = clampInt(req.body?.days ?? 84, 7, 365, 84);
      const budget =
        req.body?.budget != null && req.body?.budget !== ""
          ? Number(req.body.budget)
          : null;
      const targetDays =
        req.body?.targetDays != null && req.body?.targetDays !== ""
          ? Number(req.body.targetDays)
          : 21;

      const maxLines = clampInt(req.body?.maxLines ?? 300, 10, 500, 300);
      const candidateCap = clampInt(req.body?.candidateCap ?? 650, 100, 1200, 650);
      const notes = (req.body?.notes || "").toString().trim();

      // Build snapshot with plenty of raw coverage (internal only)
      const snapshot = await buildSnapshot({
        merchantId,
        days,
        limitTop: 5000,
        limitZero: 5000,
        includeTopSellers: true,
        includeZeroOrNegative: true,
        includeRemovalCandidates: false,
      });

      // Merge + dedupe by variation_id
      const byVid = new Map();
      for (const r of snapshot.topSellers) byVid.set(r.variation_id, r);
      for (const r of snapshot.zeroOrNegative) byVid.set(r.variation_id, r);

      const all = Array.from(byVid.values());

      // Filter + slim to candidates (token-safe)
      const candidates = all
        .filter((r) => shouldConsiderForOrder(r, targetDays))
        .map((r) => {
          const unit_cost_est = estUnitCost(r);
          const suggested_qty = computeSuggestedQty(r, targetDays);

          return {
            variation_id: r.variation_id,
            sku: r.sku ?? null,
            gtin: r.gtin ?? null,
            item_name: r.item_name ?? null,
            category_name: r.category_name ?? null,
            vendor: r.vendor ?? null,

            on_hand: safeNum(r.on_hand),
            sold_units: safeNum(r.sold_units),
            avg_daily_units: safeNum(r.avg_daily_units),
            days_of_supply: r.days_of_supply == null ? null : safeNum(r.days_of_supply),

            unit_cost_est: unit_cost_est,
            suggested_qty: suggested_qty,
          };
        });

      // Sort: stockouts + velocity first
      candidates.sort((a, b) => {
        const aStock = safeNum(a.on_hand) <= 0 ? 1 : 0;
        const bStock = safeNum(b.on_hand) <= 0 ? 1 : 0;
        if (bStock !== aStock) return bStock - aStock;
        return safeNum(b.avg_daily_units) - safeNum(a.avg_daily_units);
      });

      const candidatesSent = candidates.slice(0, candidateCap);

      const userObj = {
        merchantId,
        constraints: { budget, targetDays, maxLines },
        notes,
        meta: {
          days,
          candidateCap,
          snapshotCounts: snapshot.counts,
          candidatesTotal: candidates.length,
          candidatesSent: candidatesSent.length,
        },
        candidates: candidatesSent,
      };

      const plan = await callOpenAIJson({
        system: planSystemPrompt(),
        userObj,
      });

      // Save latest plan (optional)
      await firestore
        .collection("merchants")
        .doc(merchantId)
        .collection("ai_replenishment_plans")
        .doc("latest")
        .set(
          {
            updated_at: nowIso(),
            days,
            targetDays,
            budget,
            maxLines,
            candidateCap,
            notes,
            meta: userObj.meta,
            plan,
          },
          { merge: true }
        );

      return res.json({
        ok: true,
        plan,
        meta: userObj.meta,
      });
    } catch (e) {
      if (isQuota429(e)) {
        return res.status(429).json({
          ok: false,
          error: "OpenAI API quota exceeded for this API key/project. Enable billing or increase limits, then retry.",
          code: "OPENAI_QUOTA_EXCEEDED",
        });
      }
      if (e?.raw) {
        return res.status(500).json({
          ok: false,
          error: e.message || "AI failed",
          raw: String(e.raw).slice(0, 8000),
        });
      }
      console.error("Error in /api/replenishment-ai/plan:", e);
      return res.status(500).json({ ok: false, error: e.message || "Failed to generate plan" });
    }
  });

  /**
   * POST /api/replenishment-ai/audit
   * body: {
   *   merchantId,
   *   days?,
   *   notes?,
   *   includeTopSellers?,
   *   includeZeroOrNegative?,
   *   includeRemovalCandidates?
   * }
   *
   * ✅ Audit still sends raw lists but capped; usually smaller than plan candidates.
   */
  router.post("/api/replenishment-ai/audit", requireLogin, async (req, res) => {
    try {
      const merchantId = (req.body?.merchantId || "").toString().trim().replace(/^\/+/, "");
      if (!merchantId) return res.status(400).json({ ok: false, error: "Missing merchantId" });

      const days = clampInt(req.body?.days ?? 84, 7, 365, 84);
      const notes = (req.body?.notes || "").toString().trim();

      const includeTopSellers = req.body?.includeTopSellers != null ? !!req.body.includeTopSellers : false;
      const includeZeroOrNegative = req.body?.includeZeroOrNegative != null ? !!req.body.includeZeroOrNegative : true;
      const includeRemovalCandidates = req.body?.includeRemovalCandidates != null ? !!req.body.includeRemovalCandidates : true;

      const snapshot = await buildSnapshot({
        merchantId,
        days,
        limitTop: includeTopSellers ? 300 : 0,
        limitZero: includeZeroOrNegative ? 900 : 0,
        limitRemoval: includeRemovalCandidates ? 900 : 0,
        includeTopSellers,
        includeZeroOrNegative,
        includeRemovalCandidates,
      });

      // Slim audit payload too (avoid accidental context errors)
      const slim = (r) => ({
        variation_id: r.variation_id,
        sku: r.sku ?? null,
        gtin: r.gtin ?? null,
        item_name: r.item_name ?? null,
        category_name: r.category_name ?? null,
        vendor: r.vendor ?? null,
        on_hand: safeNum(r.on_hand),
        sold_units: safeNum(r.sold_units),
        avg_daily_units: safeNum(r.avg_daily_units),
        days_of_supply: r.days_of_supply == null ? null : safeNum(r.days_of_supply),
        unit_cost_est: estUnitCost(r),
      });

      const userObj = {
        merchantId,
        notes,
        snapshot: {
          merchantId: snapshot.merchantId,
          range: snapshot.range,
          counts: snapshot.counts,
          topSellers: includeTopSellers ? snapshot.topSellers.slice(0, 250).map(slim) : [],
          zeroOrNegative: includeZeroOrNegative ? snapshot.zeroOrNegative.slice(0, 800).map(slim) : [],
          removalCandidates: includeRemovalCandidates ? snapshot.removalCandidates.slice(0, 800).map(slim) : [],
        },
      };

      const audit = await callOpenAIJson({
        system: auditSystemPrompt(),
        userObj,
      });

      await firestore
        .collection("merchants")
        .doc(merchantId)
        .collection("ai_replenishment_audits")
        .doc("latest")
        .set(
          { updated_at: nowIso(), days, notes, audit },
          { merge: true }
        );

      return res.json({
        ok: true,
        audit,
        snapshotMeta: { range: snapshot.range, counts: snapshot.counts },
      });
    } catch (e) {
      if (isQuota429(e)) {
        return res.status(429).json({
          ok: false,
          error: "OpenAI API quota exceeded for this API key/project. Enable billing or increase limits, then retry.",
          code: "OPENAI_QUOTA_EXCEEDED",
        });
      }
      if (e?.raw) {
        return res.status(500).json({
          ok: false,
          error: e.message || "AI failed",
          raw: String(e.raw).slice(0, 8000),
        });
      }
      console.error("Error in /api/replenishment-ai/audit:", e);
      return res.status(500).json({ ok: false, error: e.message || "Failed to generate audit" });
    }
  });

  return router;
};
