// routes/copyItemInfo.js
// ------------------------------------------------------------
// Square-first copy + sync
// Fixes:
//  - Duplicate object variationId (don’t send variation twice in same upsert)
//  - Item must have at least one variation (don’t upsert ITEM without variations)
// Strategy:
//  - If only variation fields change (price/sku), upsert VARIATION only.
//  - If any item-level fields change (name/category/custom attrs), upsert ITEM (with variations),
//    and apply variation changes by mutating the embedded variation inside itemData.variations.
// ------------------------------------------------------------

const express = require("express");
const router = express.Router();
const { makeCreateSquareClientForMerchant } = require("../lib/square");
const crypto = require("crypto");

function newIdemKey(prefix = "copy") {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

const inflight = new Map();

function safeJson(obj) {
  return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? Number(v) : v), 2);
}

function dbg(label, obj) {
  try {
    console.log(`[copyItemInfo] ${label}`, safeJson(obj));
  } catch {
    console.log(`[copyItemInfo] ${label}`, obj);
  }
}

function lockKey(gtin, toMerchantId) {
  return `${gtin}::${toMerchantId}`;
}

function acquireLock(key, ttlMs = 15000) {
  const now = Date.now();
  const prev = inflight.get(key);
  if (prev && now - prev < ttlMs) return false;
  inflight.set(key, now);
  return true;
}

function releaseLock(key) {
  inflight.delete(key);
}

function toCents(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100);
}

function locIdForKey(locKey) {
  return Buffer.from(locKey, "utf8").toString("base64").replace(/=+$/g, "");
}

function digitsOnly(s) {
  return String(s || "").replace(/\D+/g, "");
}

function normalizeUpcFromGtin(gtin) {
  const d = digitsOnly(gtin);
  if (!d) return null;
  if (d.length === 12) return d;
  if (d.length === 13) return d;
  return null;
}

function normalizeText(v) {
  const s = (v ?? "").toString().trim();
  return s || null;
}

function normalizeReportingCategory(fromDataOrPatch) {
  return (
    normalizeText(fromDataOrPatch?.reporting_category_name) ||
    normalizeText(fromDataOrPatch?.reportingCategoryName) ||
    normalizeText(fromDataOrPatch?.reporting_category) ||
    normalizeText(fromDataOrPatch?.reportingCategory) ||
    null
  );
}

function normalizeVendor(fromDataOrPatch) {
  return normalizeText(fromDataOrPatch?.vendor_name) || normalizeText(fromDataOrPatch?.vendor) || null;
}

function normalizeUnitPriceCandidate(fromDataOrPatch) {
  const candidates = [
    fromDataOrPatch?.unit_price,
    fromDataOrPatch?.unitPrice,
    fromDataOrPatch?.unitPriceNumber,
    fromDataOrPatch?.price,
    fromDataOrPatch?.default_price,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stripMerchantAndLocationFieldsForCopy(doc) {
  const out = { ...(doc || {}) };
  const removeKeys = [
    "merchant_id",
    "merchantId",
    "merchant",
    "merchant_name",
    "merchantName",
    "business_name",
    "businessName",
    "location_id",
    "locationId",
    "location_name",
    "locationName",
    "locKey",
    "loc_key",
  ];
  for (const k of removeKeys) delete out[k];
  return out;
}

async function resolveLocKeyToMeta(firestore, locKey) {
  const docId = locIdForKey(locKey);
  const byId = await firestore.collection("location_index").doc(docId).get();
  if (byId.exists) return byId.data();

  const snap = await firestore.collection("location_index").where("locKey", "==", locKey).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

function computeMismatchAndSpread(pricesByLocation) {
  const prices = [];
  for (const k of Object.keys(pricesByLocation || {})) {
    const p = pricesByLocation?.[k]?.price;
    if (typeof p === "number" && Number.isFinite(p)) prices.push(p);
  }
  if (prices.length <= 1) return { has_mismatch: false, price_spread: 0 };
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = +(max - min).toFixed(4);
  return { has_mismatch: spread > 0.0001, price_spread: spread };
}

async function getMatrixPriceForLocKey(firestore, gtin, locKey) {
  const snap = await firestore.collection("gtin_inventory_matrix").doc(gtin).get();
  if (!snap.exists) return { price: null, currency: "USD" };

  const data = snap.data() || {};
  const pb = data.pricesByLocation || data.prices_by_location || data.locations || {};
  const info = pb?.[locKey];

  const price = info && typeof info.price === "number" ? info.price : null;
  const currency = (info?.currency || "USD").toString().toUpperCase();

  return { price, currency };
}

// -----------------------------
// Square Custom Attributes — best-effort
// -----------------------------
async function ensureSquareItemCustomAttrDefs(squareClient) {
  const defs = [
    { key: "vendor_name", name: "Vendor Name" },
    { key: "reporting_category", name: "Reporting Category" },
  ];

  const catalogApi = squareClient.catalogApi;

  let existing = [];
  try {
    const resp = await catalogApi.listCatalog(undefined, "CUSTOM_ATTRIBUTE_DEFINITION", undefined);
    existing = resp?.result?.objects || [];
  } catch {
    existing = [];
  }

  const out = {};
  for (const d of defs) {
    const found = existing.find(
      (o) =>
        o.type === "CUSTOM_ATTRIBUTE_DEFINITION" &&
        (o.customAttributeDefinitionData?.key || "").toString().trim() === d.key
    );
    if (found?.id) {
      out[d.key] = found.id;
      continue;
    }

    try {
      const up = await catalogApi.upsertCatalogObject({
        idempotencyKey: newIdemKey("cad"),
        object: {
          type: "CUSTOM_ATTRIBUTE_DEFINITION",
          id: `#CAD_${d.key}`,
          customAttributeDefinitionData: {
            key: d.key,
            name: d.name,
            allowedObjectTypes: ["ITEM"],
            description: d.name,
            visibility: "VISIBILITY_READ_WRITE_VALUES",
            schema: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "string",
            },
          },
        },
      });

      const createdId = up?.result?.catalogObject?.id || null;
      if (createdId) out[d.key] = createdId;
    } catch {
      // ignore
    }
  }

  return out;
}

function buildSquareItemCustomAttributeValues({ vendorName, reportingCategory }) {
  const cav = {};
  if (vendorName) cav["vendor_name"] = { stringValue: vendorName };
  if (reportingCategory) cav["reporting_category"] = { stringValue: reportingCategory };
  return Object.keys(cav).length ? cav : null;
}

async function createSquareItemAndVariation({
  squareClient,
  gtin,
  itemName,
  sku,
  price,
  currency,
  categoryId,
  customAttributeValues,
}) {
  const catalogApi = squareClient.catalogApi;

  const itemTempId = `#ITEM_${gtin}`;
  const varTempId = `#VAR_${gtin}`;

  const cents = toCents(price);
  const priceMoney = cents == null ? null : { amount: cents, currency };
  const safePriceMoney = priceMoney || { amount: 0, currency };

  const body = {
    idempotencyKey: newIdemKey("copy-create"),
    object: {
      type: "ITEM",
      id: itemTempId,
      customAttributeValues: customAttributeValues || undefined,
      itemData: {
        name: itemName || `GTIN ${gtin}`,
        categoryId: categoryId || undefined,
        variations: [
          {
            type: "ITEM_VARIATION",
            id: varTempId,
            itemVariationData: {
              name: "Regular",
              sku: sku || undefined,
              pricingType: "FIXED_PRICING",
              priceMoney: safePriceMoney,
            },
          },
        ],
      },
    },
  };

  const resp = await catalogApi.upsertCatalogObject(body);

  const result = resp?.result || {};
  const created = result.catalogObject || null;
  const idMappings = result.idMappings || [];

  const itemMap = idMappings.find((m) => m.clientObjectId === itemTempId);
  const varMap = idMappings.find((m) => m.clientObjectId === varTempId);

  const itemId = itemMap?.objectId || created?.id || null;
  const variationId = varMap?.objectId || null;

  if (!itemId || !variationId) {
    throw new Error(`Square create failed: missing itemId/variationId (itemId=${itemId}, variationId=${variationId})`);
  }

  return { itemId, variationId };
}

async function resolveDestTaxIds(squareClient) {
  const catalogApi = squareClient.catalogApi;

  const resp = await catalogApi.listCatalog(undefined, "TAX", undefined);
  const taxes = resp?.result?.objects || [];

  const enabled = taxes.filter((t) => t?.taxData?.enabled === true);
  const chosen = enabled[0] || taxes[0] || null;

  return chosen?.id ? [chosen.id] : [];
}

async function applyTaxesToSquareItem({ squareClient, itemId, taxIds }) {
  if (!Array.isArray(taxIds) || taxIds.length === 0) {
    return { ok: false, error: "No taxIds available to apply" };
  }

  const catalogApi = squareClient.catalogApi;

  const r = await catalogApi.batchRetrieveCatalogObjects({
    objectIds: [itemId],
    includeRelatedObjects: false,
  });

  const itemObj = (r?.result?.objects || []).find((o) => o.id === itemId && o.type === "ITEM");
  if (!itemObj) return { ok: false, notFound: true };

  itemObj.itemData = { ...(itemObj.itemData || {}), taxIds };

  await catalogApi.batchUpsertCatalogObjects({
    idempotencyKey: `tax-${Date.now()}`,
    batches: [{ objects: [itemObj] }],
  });

  return { ok: true };
}

function squareErr(e) {
  const out = {
    message: e?.message || String(e),
    statusCode: e?.statusCode || e?.response?.status || null,
  };

  const candidates = [e?.errors, e?.result?.errors, e?.body, e?.response?.body, e?.response?.data].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c)) {
      out.errors = c;
      break;
    }
    if (typeof c === "object") {
      if (Array.isArray(c.errors)) out.errors = c.errors;
      else out.bodyObj = c;
      break;
    }
    if (typeof c === "string") {
      out.body = c;
      try {
        const parsed = JSON.parse(c);
        if (Array.isArray(parsed?.errors)) out.errors = parsed.errors;
        else out.bodyObj = parsed;
      } catch {}
      break;
    }
  }

  return out;
}

function shallowEq(a, b) {
  return (a ?? "").toString().trim() === (b ?? "").toString().trim();
}

/**
 * Update destination Square item + variation WITHOUT duplicate-id + WITHOUT "no variations" error.
 * Logic:
 *   - If we need item-level updates, upsert ITEM (with variations) and apply variation mutations inside embedded variation.
 *   - Else upsert VARIATION only.
 */
async function updateSquareItemAndVariation({
  squareClient,
  itemId,
  variationId,
  itemName,
  sku,
  price,
  currency,
  gtin,
  categoryId,
  customAttributeValues,
}) {
  const catalogApi = squareClient.catalogApi;

  let retrieve;
  try {
    retrieve = await catalogApi.batchRetrieveCatalogObjects({
      objectIds: [itemId, variationId],
      includeRelatedObjects: false,
    });
  } catch (e) {
    const se = squareErr(e);
    dbg("Square batchRetrieve THREW", { gtin, itemId, variationId, error: se });
    return { ok: false, ...se };
  }

  const objs = retrieve?.result?.objects || [];
  const itemObj = objs.find((o) => o.id === itemId);
  const varObj = objs.find((o) => o.id === variationId);

  const embeddedVars = itemObj?.itemData?.variations || [];
  const embeddedVar = Array.isArray(embeddedVars)
    ? embeddedVars.find((v) => v?.id === variationId)
    : null;

  dbg("Square retrieve BEFORE update", {
    gtin,
    itemId,
    variationId,
    gotItem: !!itemObj,
    gotVar: !!varObj,
    item_name: itemObj?.itemData?.name,
    categoryId: itemObj?.itemData?.categoryId,
    customAttributeValues: itemObj?.customAttributeValues || null,
    var_sku: varObj?.itemVariationData?.sku,
    var_priceMoney: varObj?.itemVariationData?.priceMoney || null,
    embedded_has_var: !!embeddedVar,
    embedded_vars_count: Array.isArray(embeddedVars) ? embeddedVars.length : null,
  });

  if (!itemObj || itemObj.type !== "ITEM" || !varObj || varObj.type !== "ITEM_VARIATION") {
    return { ok: false, notFound: true };
  }

  const needsItemName = !!itemName && !shallowEq(itemObj?.itemData?.name, itemName);
  const needsCategory = !!categoryId && !shallowEq(itemObj?.itemData?.categoryId, categoryId);
  const needsCustomAttrs = !!customAttributeValues && Object.keys(customAttributeValues || {}).length > 0;

  const needsItemUpsert = needsItemName || needsCategory || needsCustomAttrs;

  // Always compute desired variation changes
  const cents = price != null ? toCents(price) : null;
  const wantPriceMoney =
    cents != null ? { amount: cents, currency: (currency || "USD").toString().toUpperCase() } : null;

  // ------------------------
  // CASE A: ITEM-level changes → upsert ITEM (WITH variations)
  // ------------------------
  if (needsItemUpsert) {
    // mutate item
    if (needsCategory) itemObj.itemData = { ...(itemObj.itemData || {}), categoryId };
    if (needsItemName) itemObj.itemData = { ...(itemObj.itemData || {}), name: itemName };

    if (needsCustomAttrs) {
      itemObj.customAttributeValues = {
        ...(itemObj.customAttributeValues || {}),
        ...customAttributeValues,
      };
    }

    // IMPORTANT: apply variation changes INSIDE embedded variation (so we don't upsert var separately)
    // If embedded variation isn't present, we fall back to varObj injection into variations.
    let vars = Array.isArray(itemObj.itemData?.variations) ? [...itemObj.itemData.variations] : [];
    let idx = vars.findIndex((v) => v?.id === variationId);

    if (idx === -1) {
      // embed the varObj so ITEM still has a variation and we can apply changes
      vars.push(varObj);
      idx = vars.length - 1;
    }

    const v = { ...(vars[idx] || {}) };
    const vd = { ...(v.itemVariationData || {}) };

    if (sku) vd.sku = sku;
    if (wantPriceMoney) {
      vd.pricingType = "FIXED_PRICING";
      vd.priceMoney = wantPriceMoney;
    }

    v.itemVariationData = vd;
    vars[idx] = v;

    // ensure at least one variation
    if (!vars.length) {
      return { ok: false, message: "Refused: ITEM upsert requires at least one variation but none available." };
    }

    itemObj.itemData = { ...(itemObj.itemData || {}), variations: vars };

    dbg("Square ITEM upsert payload (with variations)", {
      gtin,
      itemId,
      variationId,
      new_item_name: itemObj?.itemData?.name,
      new_categoryId: itemObj?.itemData?.categoryId,
      has_variations: Array.isArray(itemObj?.itemData?.variations) && itemObj.itemData.variations.length > 0,
      embedded_var_sku: itemObj?.itemData?.variations?.find((x) => x?.id === variationId)?.itemVariationData?.sku,
      embedded_var_priceMoney:
        itemObj?.itemData?.variations?.find((x) => x?.id === variationId)?.itemVariationData?.priceMoney || null,
    });

    try {
      const rItem = await catalogApi.upsertCatalogObject({
        idempotencyKey: newIdemKey("copy-item"),
        object: itemObj,
      });
      const errs = rItem?.result?.errors || [];
      if (errs.length) {
        dbg("Square ITEM upsert returned errors", { gtin, itemId, errors: errs });
        return { ok: false, message: "Square ITEM upsert returned errors", errors: errs };
      }
    } catch (e) {
      const se = squareErr(e);
      dbg("Square ITEM upsert THREW", { gtin, itemId, error: se });
      return { ok: false, message: "Square ITEM upsert threw", ...se };
    }

    dbg("Square upsert success (ITEM with embedded variation)", { gtin, itemId, variationId });
    return { ok: true, objects: [{ id: itemId, type: "ITEM" }] };
  }

  // ------------------------
  // CASE B: no item-level changes → upsert VARIATION only
  // ------------------------
  const varData = { ...(varObj.itemVariationData || {}) };
  if (sku) varData.sku = sku;
  if (wantPriceMoney) {
    varData.pricingType = "FIXED_PRICING";
    varData.priceMoney = wantPriceMoney;
  }
  varObj.itemVariationData = varData;

  dbg("Square VARIATION upsert payload", {
    gtin,
    variationId,
    new_var_sku: varObj?.itemVariationData?.sku,
    new_var_priceMoney: varObj?.itemVariationData?.priceMoney || null,
  });

  try {
    const rVar = await catalogApi.upsertCatalogObject({
      idempotencyKey: newIdemKey("copy-var"),
      object: varObj,
    });
    const errs = rVar?.result?.errors || [];
    if (errs.length) {
      dbg("Square VARIATION upsert returned errors", { gtin, variationId, errors: errs });
      return { ok: false, message: "Square VARIATION upsert returned errors", errors: errs };
    }
  } catch (e) {
    const se = squareErr(e);
    dbg("Square VARIATION upsert THREW", { gtin, variationId, error: se });
    return { ok: false, message: "Square VARIATION upsert threw", ...se };
  }

  dbg("Square upsert success (VARIATION only)", { gtin, itemId, variationId });
  return { ok: true, objects: [{ id: variationId, type: "ITEM_VARIATION" }] };
}

async function getOrCreateCategoryIdByName(client, name) {
  if (!name) return null;
  const nm = name.trim();
  if (!nm) return null;

  const { result: sr } = await client.catalogApi.searchCatalogObjects({
    objectTypes: ["CATEGORY"],
    query: { textQuery: { keywords: [nm] } },
    includeRelatedObjects: false,
  });

  const hit = (sr?.objects || []).find((o) => (o?.categoryData?.name || "").trim().toLowerCase() === nm.toLowerCase());
  if (hit?.id) return hit.id;

  const { result: up } = await client.catalogApi.upsertCatalogObject({
    idempotencyKey: crypto.randomUUID(),
    object: {
      type: "CATEGORY",
      id: `#cat_${crypto.randomUUID().slice(0, 8)}`,
      categoryData: { name: nm },
    },
  });

  return up?.catalogObject?.id || null;
}

// ------------------------------------------------------------

module.exports = function buildCopyItemInfoRouter({ requireLogin, firestore }) {
  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  router.post("/api/copy-item-info", requireLogin, async (req, res) => {
    console.log("🔥 HIT /api/copy-item-info", {
      gtin: req.body?.gtin,
      fromLocKey: req.body?.fromLocKey,
      toLocKey: req.body?.toLocKey,
      user: req.user?.email || req.user?.id || null,
    });

    try {
      const gtin = (req.body?.gtin || "").toString().trim();
      const fromLocKey = (req.body?.fromLocKey || "").toString().trim();
      const toLocKey = (req.body?.toLocKey || "").toString().trim();

      const createIfMissing = req.body?.createIfMissing === undefined ? true : !!req.body.createIfMissing;
      const alsoUpdateSquare = req.body?.alsoUpdateSquare === undefined ? true : !!req.body.alsoUpdateSquare;

      if (!gtin) return res.status(400).json({ success: false, error: "Missing gtin" });
      if (!fromLocKey) return res.status(400).json({ success: false, error: "Missing fromLocKey" });
      if (!toLocKey) return res.status(400).json({ success: false, error: "Missing toLocKey" });
      if (fromLocKey === toLocKey) {
        return res.status(400).json({ success: false, error: "fromLocKey and toLocKey cannot be the same" });
      }

      const [fromMeta, toMeta] = await Promise.all([
        resolveLocKeyToMeta(firestore, fromLocKey),
        resolveLocKeyToMeta(firestore, toLocKey),
      ]);

      if (!fromMeta) {
        return res.status(404).json({ success: false, error: `fromLocKey not found in location_index: ${fromLocKey}` });
      }
      if (!toMeta) {
        return res.status(404).json({ success: false, error: `toLocKey not found in location_index: ${toLocKey}` });
      }

      const fromMerchantId = (fromMeta.merchant_id || "").toString().trim();
      const toMerchantId = (toMeta.merchant_id || "").toString().trim();
      const toLocationId = (toMeta?.location_id || "").toString().trim() || null;

      if (!fromMerchantId) {
        return res.status(400).json({
          success: false,
          error: `location_index missing merchant_id for fromLocKey: ${fromLocKey}`,
        });
      }
      if (!toMerchantId) {
        return res.status(400).json({
          success: false,
          error: `location_index missing merchant_id for toLocKey: ${toLocKey}`,
        });
      }

      if (fromMerchantId === toMerchantId) {
        return res.status(400).json({
          success: false,
          error: `fromLocKey and toLocKey resolve to the SAME merchant_id (${toMerchantId}). Check location_index mapping.`,
          fromLocKey,
          toLocKey,
          fromMerchantId,
          toMerchantId,
        });
      }

      const lk = lockKey(gtin, toMerchantId);
      if (!acquireLock(lk)) {
        return res.status(429).json({
          success: false,
          error: "Copy already running for this GTIN to this destination. Try again.",
        });
      }

      try {
        if (!alsoUpdateSquare) {
          return res.status(400).json({
            success: false,
            error: "Square-first mode requires alsoUpdateSquare=true",
          });
        }

        const { price: matrixPrice, currency: matrixCurrency } = await getMatrixPriceForLocKey(
          firestore,
          gtin,
          fromLocKey
        );

        const fromInvCol = firestore.collection("merchants").doc(fromMerchantId).collection("inventory");

        let fromSnap = await fromInvCol.doc(gtin).get();
        if (!fromSnap.exists) {
          const q1 = await fromInvCol.where("gtin", "==", gtin).limit(1).get();
          if (!q1.empty) fromSnap = q1.docs[0];
        }
        if (!fromSnap.exists) {
          const q2 = await fromInvCol.where("sku", "==", gtin).limit(1).get();
          if (!q2.empty) fromSnap = q2.docs[0];
        }
        if (!fromSnap.exists) {
          return res.status(404).json({
            success: false,
            error: `Source inventory missing in Firestore for merchant ${fromMerchantId}. Tried docId=${gtin}, field gtin=${gtin}, sku=${gtin}`,
          });
        }

        const fromData = fromSnap.data() || {};

        const toInvRef = firestore.collection("merchants").doc(toMerchantId).collection("inventory").doc(gtin);
        const toSnap = await toInvRef.get();
        const toData = toSnap.exists ? toSnap.data() || {} : null;

        const patch = stripMerchantAndLocationFieldsForCopy(fromData);

        patch.gtin = gtin;
        patch.updated_at = new Date().toISOString();
        patch.updated_by = req.user?.email || req.user?.id || "unknown";

        if (toMeta.location_id) patch.location_id = toMeta.location_id;
        if (toMeta.location_name) patch.location_name = toMeta.location_name;

        const vendorName = normalizeVendor(patch) || normalizeVendor(fromData);
        const reportingCategory = normalizeReportingCategory(patch) || normalizeReportingCategory(fromData);

        const invUnitPrice = normalizeUnitPriceCandidate(patch) ?? normalizeUnitPriceCandidate(fromData);
        const srcPrice = typeof matrixPrice === "number" && Number.isFinite(matrixPrice) ? matrixPrice : invUnitPrice;
        const srcCurrency = (matrixCurrency || "USD").toString().toUpperCase();

        if (!toSnap.exists && !createIfMissing) {
          return res.status(409).json({
            success: false,
            error: "Destination missing and createIfMissing=false (Square-first: aborting)",
            gtin,
            fromLocKey,
            toLocKey,
            toMerchantId,
          });
        }

        const itemName = (patch.item_name || fromData.item_name || "").toString().trim();
        const sku = (patch.sku || fromData.sku || "").toString().trim();
        const categoryName = (patch.category_name || fromData.category_name || "").toString().trim() || null;

        let squareClient = null;
        try {
          squareClient = await createSquareClientForMerchant({ merchantId: toMerchantId });
        } catch (e) {
          return res.status(502).json({
            success: false,
            error: "Square client not available; aborting without updating Firestore/matrix",
            squareResult: { ok: false, error: e?.message || String(e) },
            gtin,
            fromLocKey,
            toLocKey,
            toMerchantId,
          });
        }

        let destCategoryId = null;
        if (categoryName) {
          try {
            destCategoryId = await getOrCreateCategoryIdByName(squareClient, categoryName);
            console.log("categoryName: " + categoryName);
            console.log("destCategoryId: " + destCategoryId);
          } catch (e) {
            return res.status(502).json({
              success: false,
              error: "Square category resolve failed; aborting without updating Firestore/matrix",
              gtin,
              fromLocKey,
              toLocKey,
              toMerchantId,
              categoryName,
              squareError: squareErr(e),
            });
          }

          if (!destCategoryId) {
            return res.status(502).json({
              success: false,
              error: "Square category could not be resolved/created; aborting without updating Firestore/matrix",
              gtin,
              fromLocKey,
              toLocKey,
              toMerchantId,
              categoryName,
            });
          }
        }

        try {
          await ensureSquareItemCustomAttrDefs(squareClient);
        } catch {
          // ignore
        }

        const customAttributeValues = buildSquareItemCustomAttributeValues({ vendorName, reportingCategory });

        const existingItemId = (toData?.item_id || toData?.square_item_id || "").toString().trim();
        const existingVarId = (toData?.variation_id || toData?.square_variation_id || "").toString().trim();

        let squareResult = null;
        let toItemId = null;
        let toVariationId = null;

        if (existingItemId && existingVarId) {
          const upd = await updateSquareItemAndVariation({
            squareClient,
            itemId: existingItemId,
            variationId: existingVarId,
            itemName,
            sku,
            price: srcPrice,
            currency: srcCurrency,
            gtin,
            categoryId: destCategoryId,
            customAttributeValues,
          });

          if (!upd?.ok && !upd?.notFound) {
            dbg("Square update failed (caller)", {
              gtin,
              toMerchantId,
              existingItemId,
              existingVarId,
              upd,
            });
          }

          if (upd?.ok) {
            squareResult = { ok: true, action: "updated", itemId: existingItemId, variationId: existingVarId, details: upd };
            toItemId = existingItemId;
            toVariationId = existingVarId;
          } else if (upd?.notFound) {
            try {
              const created = await createSquareItemAndVariation({
                squareClient,
                gtin,
                itemName,
                sku,
                price: srcPrice,
                currency: srcCurrency,
                categoryId: destCategoryId,
                customAttributeValues,
              });

              try {
                const taxIds = await resolveDestTaxIds(squareClient);
                dbg("Dest taxIds", { gtin, toMerchantId, taxIds });
                if (taxIds?.length) {
                  const taxRes = await applyTaxesToSquareItem({ squareClient, itemId: created.itemId, taxIds });
                  dbg("Applied taxes result", { gtin, toMerchantId, taxRes });
                }
              } catch (taxErr) {
                dbg("Tax apply failed (non-fatal)", squareErr(taxErr));
              }

              squareResult = {
                ok: true,
                action: "recreated",
                itemId: created.itemId,
                variationId: created.variationId,
                previous_item_id: existingItemId || null,
                previous_variation_id: existingVarId || null,
              };
              toItemId = created.itemId;
              toVariationId = created.variationId;
            } catch (e2) {
              squareResult = { ok: false, phase: "recreate", ...squareErr(e2) };
            }
          } else {
            squareResult = { ok: false, phase: "update", ...upd };
          }
        } else {
          try {
            const created = await createSquareItemAndVariation({
              squareClient,
              gtin,
              itemName,
              sku,
              price: srcPrice,
              currency: srcCurrency,
              categoryId: destCategoryId,
              customAttributeValues,
            });

            try {
              const taxIds = await resolveDestTaxIds(squareClient);
              dbg("Dest taxIds", { gtin, toMerchantId, taxIds });
              if (taxIds?.length) {
                const taxRes = await applyTaxesToSquareItem({ squareClient, itemId: created.itemId, taxIds });
                dbg("Applied taxes result", { gtin, toMerchantId, taxRes });
              }
            } catch (taxErr) {
              dbg("Tax apply failed (non-fatal)", squareErr(taxErr));
            }

            squareResult = { ok: true, action: "created", itemId: created.itemId, variationId: created.variationId };
            toItemId = created.itemId;
            toVariationId = created.variationId;
          } catch (e) {
            squareResult = { ok: false, phase: "create", ...squareErr(e) };
          }
        }

        if (!squareResult?.ok || !toItemId || !toVariationId) {
          return res.status(502).json({
            success: false,
            error: "Square upsert failed; aborting without updating Firestore/matrix",
            gtin,
            fromLocKey,
            toLocKey,
            toMerchantId,
            squareResult,
          });
        }

        // ✅ ONLY AFTER Square succeeds
        const destInvWrite = {
          ...patch,
          item_id: toItemId,
          variation_id: toVariationId,
          square_synced_at: new Date().toISOString(),
          square_sync_source: "copy-item-info",
        };

        if (!toSnap.exists) {
          await toInvRef.set(
            {
              ...destInvWrite,
              qty: 0,
              state: "placeholder",
              created_at: new Date().toISOString(),
            },
            { merge: true }
          );
        } else {
          await toInvRef.set(destInvWrite, { merge: true });
        }

        const matrixRef = firestore.collection("gtin_inventory_matrix").doc(gtin);
        const matrixSnap = await matrixRef.get();

        if (!matrixSnap.exists) {
          return res.json({
            success: true,
            squareResult,
            gtin,
            fromLocKey,
            toLocKey,
            toMerchantId,
            toLocationId: toMeta?.location_id || null,
            toItemId,
            toVariationId,
            warning: `Square updated but gtin_inventory_matrix missing doc for gtin ${gtin} (matrix not updated)`,
          });
        }

        const cur = matrixSnap.data() || {};
        const pbl = { ...(cur.pricesByLocation || cur.prices_by_location || cur.locations || {}) };

        pbl[toLocKey] = {
          ...(pbl[toLocKey] || {}),
          merchant_id: toMerchantId,
          location_id: toLocationId,
          variation_id: toVariationId,
          item_id: toItemId,
          currency: (srcCurrency || cur.currency || "USD").toString().toUpperCase(),
          price: typeof srcPrice === "number" && Number.isFinite(srcPrice) ? Number(srcPrice) : null,
          calculated_at: new Date().toISOString(),
        };

        const { has_mismatch, price_spread } = computeMismatchAndSpread(pbl);

        await matrixRef.set(
          {
            pricesByLocation: pbl,
            prices_by_location: pbl,
            locations: pbl,
            has_mismatch,
            price_spread,
            updated_at: new Date().toISOString(),
          },
          { merge: true }
        );

        await firestore.collection("audit_logs").add({
          type: "COPY_ITEM_INFO",
          gtin,
          fromLocKey,
          toLocKey,
          fromMerchantId,
          toMerchantId,
          createIfMissing,
          squareResult,
          ts: new Date().toISOString(),
          actor: req.user?.email || null,
        });

        return res.json({
          success: true,
          squareResult,
          gtin,
          fromLocKey,
          toLocKey,
          toMerchantId,
          toLocationId,
          toPrice: srcPrice,
          currency: srcCurrency,
          toItemId,
          toVariationId,
        });
      } catch (err) {
        console.error("Error in POST /api/copy-item-info:", err);
        return res.status(500).json({ success: false, error: err.message || "Internal error" });
      } finally {
        releaseLock(lk);
      }
    } catch (err) {
      console.error("Error in POST /api/copy-item-info:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
