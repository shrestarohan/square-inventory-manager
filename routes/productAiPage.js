const express = require("express");
const OpenAI = require("openai");

module.exports = function buildProductAiPageRouter({ firestore, requireLogin }) {
  const router = express.Router();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // very small in-memory cache to avoid regenerating every scan
  const _cache = new Map(); // gtin -> { expiresAt, html, json }
  const CACHE_MS = 1000 * 60 * 30; // 30 minutes

  function now() { return Date.now(); }

  function money(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  router.get("/product-ai", requireLogin, async (req, res) => {
    try {
      const gtin = (req.query.gtin || "").toString().trim();
      if (!gtin) return res.status(400).send("Missing gtin");

      // cache hit
      const cached = _cache.get(gtin);
      if (cached && cached.expiresAt > now()) {
        return res.render("product-ai", cached.json);
      }

      // pull product from your consolidated matrix doc
      const docRef = firestore.collection("gtin_inventory_matrix").doc(gtin);
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).send(`GTIN not found: ${gtin}`);

      const d = snap.data() || {};
      const pricesByLocation = d.pricesByLocation || {};

      const prices = Object.entries(pricesByLocation).map(([locKey, info]) => ({
        locKey,
        label: locKey, // if you have locationsMeta labels, swap here
        price: (typeof info?.price === "number" && Number.isFinite(info.price)) ? info.price : null,
        currency: info?.currency || info?.currency_code || "USD",
      }));

      const numeric = prices.map(p => p.price).filter(p => typeof p === "number");
      const minPrice = numeric.length ? Math.min(...numeric) : null;
      const maxPrice = numeric.length ? Math.max(...numeric) : null;

      // Build a compact product context for AI
      const productContext = {
        gtin: d.gtin || gtin,
        sku: d.sku || "",
        item_name: d.item_name || "",
        category_name: d.category_name || "",
        image_url: d.image_url || d.image || d.imageUrl || "",
        price_min: minPrice,
        price_max: maxPrice,
        locations_priced: prices.filter(p => p.price != null).length,
        locations_total: prices.length,
      };

      // Keep the prompt structured so the output is consistently useful
      const prompt = `
You are a retail merchandising assistant for a liquor/convenience store.
Generate an in-store "AI product page" for staff and customers.

Product:
${JSON.stringify(productContext, null, 2)}

Requirements:
- Produce concise, scannable content for mobile.
- Include:
  1) Short description (1–2 sentences)
  2) Key selling points (3 bullets)
  3) Best occasions / use cases (3 bullets)
  4) Upsell & cross-sell (6 bullets) — suggest complementary items and why
  5) Bundle ideas (3 bundles) with simple price-anchoring language
  6) Staff script (2 short lines) for checkout suggestive selling
  7) If category is unknown, make safe general suggestions.
- Do NOT invent regulated/medical claims.
- Avoid unsafe or illegal guidance.
Return STRICT JSON with keys:
{
 "short_description": "...",
 "selling_points": ["..."],
 "use_cases": ["..."],
 "upsells": ["..."],
 "bundles": [{"title":"...","includes":["..."],"pitch":"..."}],
 "staff_script": ["...","..."]
}
`.trim();

      const ai = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0.6,
        messages: [
          { role: "system", content: "Be helpful, realistic, and sales-focused. Output must be valid JSON." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      });

      let aiJson = {};
      try {
        aiJson = JSON.parse(ai.choices?.[0]?.message?.content || "{}");
      } catch {
        aiJson = {};
      }

      // Render model
      const viewModel = {
        item: {
          gtin: productContext.gtin,
          sku: productContext.sku,
          item_name: productContext.item_name,
          category_name: productContext.category_name,
          image_url: productContext.image_url,
        },
        prices: prices
          .slice()
          .sort((a,b) => (a.label || "").localeCompare(b.label || "")),
        minPriceText: money(minPrice),
        maxPriceText: money(maxPrice),
        ai: aiJson,
        generatedAt: new Date().toISOString(),
      };

      _cache.set(gtin, { expiresAt: now() + CACHE_MS, json: viewModel });

      return res.render("product-ai", viewModel);
    } catch (err) {
      console.error("product-ai error:", err);
      res.status(500).send("Failed to generate AI product page.");
    }
  });

  return router;
};
