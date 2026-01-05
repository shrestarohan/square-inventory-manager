// routes/copyItemInfo.js
// ------------------------------------------------------------
// PURPOSE
//   Copy item metadata from one store/location (locKey) to another
//   AND create/update the destination Square Catalog item if missing.
//
// POST /api/copy-item-info
// body:
// {
//   gtin: "0811538010405",
//   fromLocKey: "<locKey>",
//   toLocKey: "<locKey>",
//   fields: ["item_name","category_name","sku"], // optional
//   createIfMissing: true,                        // optional (default true)
//   alsoUpdateSquare: true                        // optional (default true)
// }
//
// REQUIREMENTS
// - location_index docs should include merchant_id (and ideally location_id/location_name)
// - merchants/{merchantId} doc should include square_access_token (adjust if needed)
//
// NOTES
// - For "missing destination" in Square: we CREATE a new Square ITEM + one VARIATION.
// - Price for new variation: we copy from matrix source location (fromLocKey).
//   If missing, we default to 0.00 and pricingType FIXED.
// ------------------------------------------------------------

const express = require("express");
const router = express.Router();

const { Client, Environment } = require("square/legacy");

// ---------- helpers ----------
function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, f) && obj[f] !== undefined) {
      out[f] = obj[f];
    }
  }
  return out;
}

function toCents(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100);
}

function locIdForKey(locKey) {
  return Buffer.from(locKey, "utf8").toString("base64").replace(/=+$/g, "");
}

async function resolveLocKeyToMeta(firestore, locKey) {
  const docId = locIdForKey(locKey);
  const byId = await firestore.collection("location_index").doc(docId).get();
  if (byId.exists) return byId.data();

  // Fallback query (should rarely happen)
  const snap = await firestore
    .collection("location_index")
    .where("locKey", "==", locKey)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

async function getSquareAccessTokenForMerchant(firestore, merchantId) {
  const envToken = (process.env.SQUARE_ACCESS_TOKEN || "").toString().trim();
  if (envToken) return envToken;

  // fallback to firestore if you actually store per-merchant tokens
  const snap = await firestore.collection("merchants").doc(merchantId).get();
  const data = snap.data() || {};
  const token = (data.square_access_token || data.squareAccessToken || "").toString().trim();
  return token || null;
}

function buildSquareClient(accessToken) {
  return new Client({
    environment: process.env.SQUARE_ENV === "production" ? Environment.Production : Environment.Sandbox,
    accessToken,
  });
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

/**
 * Reads the consolidated matrix doc and extracts a price for a given locKey.
 * Adjust if your doc shape differs.
 */
async function getMatrixPriceForLocKey(firestore, gtin, locKey) {
  const snap = await firestore.collection("gtin_inventory_matrix").doc(gtin).get();
  if (!snap.exists) return { price: null, currency: "USD" };

  const data = snap.data() || {};

  // Expected (from your EJS mapping): row.pricesByLocation
  const pb = data.pricesByLocation || data.prices_by_location || data.locations || {};
  const info = pb?.[locKey];

  const price = info && typeof info.price === "number" ? info.price : null;
  const currency = (info?.currency || "USD").toString().toUpperCase();

  return { price, currency };
}

function squareIdempotencyKey(prefix, ...parts) {
  // Keep it short & stable
  const raw = [prefix, ...parts].join("|");
  // Basic hash-ish without crypto dependency
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${prefix}-${h.toString(16)}`;
}

/**
 * Create a destination Square item + variation if missing.
 * Returns: { itemId, variationId }
 */
async function createSquareItemAndVariation({
  squareClient,
  gtin,
  itemName,
  sku,
  price,
  currency,
}) {
  const catalogApi = squareClient.catalogApi;

  const itemTempId = `#ITEM_${gtin}`;
  const varTempId = `#VAR_${gtin}`;

  const cents = toCents(price);
  const priceMoney = cents == null ? null : { amount: cents, currency };

  const safePriceMoney = priceMoney || { amount: 0, currency };

  const body = {
    idempotencyKey: squareIdempotencyKey("copy-create", gtin, currency),
    object: {
      type: "ITEM",
      id: itemTempId,
      itemData: {
        name: itemName || `GTIN ${gtin}`,
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

  const itemMap = idMappings.find(m => m.clientObjectId === itemTempId);
  const varMap  = idMappings.find(m => m.clientObjectId === varTempId);

  const itemId = itemMap?.objectId || created?.id || null;
  const variationId = varMap?.objectId || null;

  if (!itemId || !variationId) {
    throw new Error(
      `Square create failed: missing itemId/variationId (itemId=${itemId}, variationId=${variationId})`
    );
  }

  return { itemId, variationId };
}

/**
 * Update destination Square item fields if we have IDs.
 * (Name lives on ITEM; sku + price live on ITEM_VARIATION)
 */
async function updateSquareItemAndVariation({
  squareClient,
  itemId,
  variationId,
  itemName,
  sku,
  price,
  currency,
}) {
  const catalogApi = squareClient.catalogApi;

  const retrieve = await catalogApi.batchRetrieveCatalogObjects({
    objectIds: [itemId, variationId],
    includeRelatedObjects: false,
  });

  const objs = retrieve?.result?.objects || [];
  const itemObj = objs.find((o) => o.id === itemId);
  const varObj = objs.find((o) => o.id === variationId);

  if (!itemObj || itemObj.type !== "ITEM") {
    throw new Error("Square update failed: ITEM not found");
  }
  if (!varObj || varObj.type !== "ITEM_VARIATION") {
    throw new Error("Square update failed: VARIATION not found");
  }

  if (itemName) itemObj.itemData = { ...(itemObj.itemData || {}), name: itemName };

  const varData = { ...(varObj.itemVariationData || {}) };
  if (sku) varData.sku = sku;

  if (price != null) {
    const cents = toCents(price);
    if (cents != null) {
      varData.pricingType = "FIXED_PRICING";
      varData.priceMoney = { amount: cents, currency: (currency || "USD").toString().toUpperCase() };
    }
  }
  varObj.itemVariationData = varData;

  const idempotencyKey = squareIdempotencyKey("copy-update", itemId, variationId);

  const resp = await catalogApi.batchUpsertCatalogObjects({
    idempotencyKey,
    batches: [{ objects: [itemObj, varObj] }],
  });

  const updated = resp?.result?.objects || [];
  return { ok: true, objects: updated.map((o) => ({ id: o.id, type: o.type })) };
}

// ------------------------------------------------------------

module.exports = function buildCopyItemInfoRouter({ requireLogin, firestore }) {
  router.post("/api/copy-item-info", requireLogin, async (req, res) => {
    try {
      const gtin = (req.body?.gtin || "").toString().trim();
      const fromLocKey = (req.body?.fromLocKey || "").toString().trim();
      const toLocKey = (req.body?.toLocKey || "").toString().trim();

      const createIfMissing =
        req.body?.createIfMissing === undefined ? true : !!req.body.createIfMissing;

      const alsoUpdateSquare =
        req.body?.alsoUpdateSquare === undefined ? true : !!req.body.alsoUpdateSquare;

      const defaultFields = ["item_name", "category_name", "sku"];
      const fields = Array.isArray(req.body?.fields) && req.body.fields.length
        ? req.body.fields.map(String)
        : defaultFields;

      if (!gtin) return res.status(400).json({ success: false, error: "Missing gtin" });
      if (!fromLocKey) return res.status(400).json({ success: false, error: "Missing fromLocKey" });
      if (!toLocKey) return res.status(400).json({ success: false, error: "Missing toLocKey" });
      if (fromLocKey === toLocKey) {
        return res.status(400).json({ success: false, error: "fromLocKey and toLocKey cannot be the same" });
      }

      // Resolve locKeys -> merchant metadata
      const [fromMeta, toMeta] = await Promise.all([
        resolveLocKeyToMeta(firestore, fromLocKey),
        resolveLocKeyToMeta(firestore, toLocKey),
      ]);

      if (!fromMeta) {
        return res.status(404).json({
          success: false,
          error: `fromLocKey not found in location_index: ${fromLocKey}`,
        });
      }
      if (!toMeta) {
        return res.status(404).json({
          success: false,
          error: `toLocKey not found in location_index: ${toLocKey}`,
        });
      }

      const fromMerchantId = (fromMeta.merchant_id || "").toString().trim();
      const toMerchantId = (toMeta.merchant_id || "").toString().trim();

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

      // Determine source price/currency from matrix ONCE (used for Square + matrix update)
      const { price: srcPrice, currency: srcCurrency } = await getMatrixPriceForLocKey(
        firestore,
        gtin,
        fromLocKey
      );

      // Source inventory doc
      const fromInvCol = firestore
        .collection("merchants")
        .doc(fromMerchantId)
        .collection("inventory");

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

      // Destination inventory doc
      const toInvRef = firestore
        .collection("merchants")
        .doc(toMerchantId)
        .collection("inventory")
        .doc(gtin);

      const toSnap = await toInvRef.get();
      const toData = toSnap.exists ? (toSnap.data() || {}) : null;

      // Copy safe fields
      const patch = pick(fromData, fields);

      patch.gtin = gtin;
      patch.updated_at = new Date().toISOString();
      patch.updated_by = req.user?.email || req.user?.id || "unknown";

      // Stamp destination location fields (helps downstream)
      if (toMeta.location_id) patch.location_id = toMeta.location_id;
      if (toMeta.location_name) patch.location_name = toMeta.location_name;

      // Write Firestore first (so you always have a record even if Square fails)
      if (!toSnap.exists) {
        if (!createIfMissing) {
          return res.status(409).json({
            success: false,
            error: "Destination missing and createIfMissing=false",
          });
        }

        await toInvRef.set(
          {
            ...patch,
            qty: 0,
            state: "placeholder",
            created_at: new Date().toISOString(),
          },
          { merge: true }
        );
      } else {
        await toInvRef.set(patch, { merge: true });
      }

      // ----------------------------
      // Square: create/update in destination merchant
      // ----------------------------
      let squareResult = null;

      if (alsoUpdateSquare) {
        const itemName = (patch.item_name || fromData.item_name || "").toString().trim();
        const sku = (patch.sku || fromData.sku || "").toString().trim();

        const destToken = await getSquareAccessTokenForMerchant(firestore, toMerchantId);
        if (!destToken) {
          squareResult = { ok: false, error: `No Square token for destination merchant ${toMerchantId}` };
        } else {
          const squareClient = buildSquareClient(destToken);

          const existingItemId = (toData?.item_id || toData?.square_item_id || "").toString().trim();
          const existingVarId = (toData?.variation_id || toData?.square_variation_id || "").toString().trim();

          if (existingItemId && existingVarId) {
            await updateSquareItemAndVariation({
              squareClient,
              itemId: existingItemId,
              variationId: existingVarId,
              itemName,
              sku,
              price: srcPrice,
              currency: srcCurrency,
            });

            await toInvRef.set(
              {
                item_id: existingItemId,
                variation_id: existingVarId,
                square_synced_at: new Date().toISOString(),
                square_sync_source: "copy-item-info",
              },
              { merge: true }
            );

            squareResult = { ok: true, action: "updated", itemId: existingItemId, variationId: existingVarId };
          } else {
            const created = await createSquareItemAndVariation({
              squareClient,
              gtin,
              itemName,
              sku,
              price: srcPrice,
              currency: srcCurrency,
            });

            await toInvRef.set(
              {
                item_id: created.itemId,
                variation_id: created.variationId,
                square_synced_at: new Date().toISOString(),
                square_sync_source: "copy-item-info",
              },
              { merge: true }
            );

            squareResult = { ok: true, action: "created", itemId: created.itemId, variationId: created.variationId };
          }
        }
      }

      // Pull destination ids from Square result or Firestore inventory
      let toItemId = null;
      let toVariationId = null;

      if (squareResult?.ok) {
        toItemId = squareResult.itemId || null;
        toVariationId = squareResult.variationId || null;
      } else {
        const toInvSnap2 = await toInvRef.get();
        const toInv2 = toInvSnap2.exists ? (toInvSnap2.data() || {}) : {};
        toItemId = (toInv2.item_id || "").toString().trim() || null;
        toVariationId = (toInv2.variation_id || "").toString().trim() || null;
      }

      // ✅ ADD THIS GUARD HERE (right after Square step)
      if (!toMerchantId || !toVariationId) {
        return res.json({
          success: true,
          squareResult,
          gtin,
          fromLocKey,
          toLocKey,
          toMerchantId,
          toLocationId: toMeta?.location_id || null,
          toItemId: toItemId || null,
          toVariationId: toVariationId || null,
          toPrice: (typeof srcPrice === "number" && Number.isFinite(srcPrice)) ? Number(srcPrice) : null,
          currency: (srcCurrency || "USD").toString().toUpperCase(),
          warning: "Square IDs missing (token/config). Matrix not updated.",
        });
      }

      // ------------------------------
      // ✅ Update gtin_inventory_matrix in-place so dashboard reflects immediately
      // ------------------------------
      const matrixRef = firestore.collection("gtin_inventory_matrix").doc(gtin);
      const matrixSnap = await matrixRef.get();

      if (!matrixSnap.exists) {
        throw new Error(`gtin_inventory_matrix missing doc for gtin ${gtin}`);
      }

      const cur = matrixSnap.data() || {};
      const pricesByLocation = { ...(cur.pricesByLocation || {}) };

      const toLocationId = (toMeta.location_id || "").toString().trim() || null;

      pricesByLocation[toLocKey] = {
        ...(pricesByLocation[toLocKey] || {}),
        merchant_id: toMerchantId,
        location_id: toLocationId,
        variation_id: toVariationId,
        item_id: toItemId,
        currency: (srcCurrency || cur.currency || "USD").toString().toUpperCase(),
        price: (typeof srcPrice === "number" && Number.isFinite(srcPrice)) ? Number(srcPrice) : null,
        calculated_at: new Date().toISOString(),
      };

      const { has_mismatch, price_spread } = computeMismatchAndSpread(pricesByLocation);

      await matrixRef.set(
        {
          pricesByLocation,
          has_mismatch,
          price_spread,
          updated_at: new Date().toISOString(),
        },
        { merge: true }
      );

      // Audit log
      await firestore.collection("audit_logs").add({
        type: "COPY_ITEM_INFO",
        gtin,
        fromLocKey,
        toLocKey,
        fromMerchantId,
        toMerchantId,
        fields,
        createIfMissing,
        alsoUpdateSquare,
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
        toItemId,
        toVariationId,
        toPrice: (typeof srcPrice === "number" && Number.isFinite(srcPrice)) ? Number(srcPrice) : null,
        currency: (srcCurrency || "USD").toString().toUpperCase(),
      });
    } catch (err) {
      console.error("Error in POST /api/copy-item-info:", err);
      return res.status(500).json({ success: false, error: err.message || "Internal error" });
    }
  });

  return router;
};
