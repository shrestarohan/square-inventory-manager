// routes/itemImages.js
// ------------------------------------------------------------
// POST /api/update-item-image  (multipart form-data)
// fields:
//   - image: <file>
//   - gtin:  <string>
//
// Finds all inventory rows by GTIN, then for each merchant uploads the image
// to Square via HTTP multipart and attaches it to each ITEM (item_id).
//
// IMPORTANT:
// Square /v2/catalog/images requires multipart/form-data with fields:
//   - image_file (binary)
//   - request (json string with idempotency_key + object_id)
//
// Using global fetch (undici) + npm form-data often breaks multipart parsing.
// This implementation uses axios + form-data + Content-Length (reliable).
// ------------------------------------------------------------

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const { makeCreateSquareClientForMerchant } = require("../lib/square");
const sharp = require("sharp");

function isWebp(mimetype, filename) {
  return (
    (mimetype || "").toLowerCase() === "image/webp" ||
    (filename || "").toLowerCase().endsWith(".webp")
  );
}

async function normalizeImageForSquare({ buffer, filename, mimetype }) {
  // If webp, convert to jpeg (very compatible) and rename
  if (isWebp(mimetype, filename)) {
    const jpegBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
    const base = (filename || "upload").replace(/\.webp$/i, "");
    return {
      buffer: jpegBuffer,
      filename: `${base}.jpg`,
      mimetype: "image/jpeg",
      convertedFromWebp: true,
    };
  }

  // Otherwise pass through
  return { buffer, filename, mimetype, convertedFromWebp: false };
}

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes((file.mimetype || "").toLowerCase());
    cb(ok ? null : new Error("Only JPG/PNG/WEBP images are allowed"), ok);
  },
});

function nowIso() {
  return new Date().toISOString();
}

function squareBaseUrl(env) {
  return env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

function safeName(filename) {
  const s = (filename || "").toString().trim();
  if (!s) return `upload-${Date.now()}.jpg`;
  return s.length > 120 ? s.slice(0, 120) : s;
}

function getFormLength(form) {
  return new Promise((resolve, reject) => {
    form.getLength((err, len) => (err ? reject(err) : resolve(len)));
  });
}

/**
 * Upload image to Square and attach to ITEM (object_id = itemId)
 * via axios multipart (reliable).
 */
async function uploadImageToSquareHttp({ accessToken, env, itemId, buffer, filename, mimetype }) {
  const url = `${squareBaseUrl(env)}/v2/catalog/images`;

  const form = new FormData();

  // ✅ file part
  form.append("image_file", buffer, {
    filename: safeName(filename),
    contentType: mimetype || "image/jpeg",
  });

  // ✅ request must include "image"
  form.append(
    "request",
    JSON.stringify({
      idempotency_key: `img-${itemId}-${Date.now()}`,
      object_id: itemId,
      is_primary: true,
      image: {
        id: "#image",
        type: "IMAGE",
        image_data: {
          // name is required in many configs
          name: safeName(filename),
          caption: "Uploaded from dashboard",
        },
      },
    }),
    { contentType: "application/json" }
  );

  const length = await getFormLength(form);

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...form.getHeaders(),
    "Content-Length": length,
  };

  const resp = await axios.post(url, form, {
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  const data = resp.data;

  if (resp.status < 200 || resp.status >= 300) {
    const msg =
      data?.errors?.[0]?.detail ||
      data?.errors?.[0]?.code ||
      (typeof data === "string" ? data : JSON.stringify(data));

    console.error("Square /v2/catalog/images failed:", {
      status: resp.status,
      statusText: resp.statusText,
      itemId,
      env,
      bodyJson: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    });

    throw new Error(`Square image upload failed (${resp.status}): ${msg}`);
  }

  const imageObj = data?.image || data?.catalog_object || data?.catalogObject || null;
  const imageUrl = imageObj?.image_data?.url || imageObj?.imageData?.url || null;

  return { imageObj, imageUrl };
}


module.exports = function buildItemImagesRouter({ firestore, requireLogin }) {
  // We keep this so your existing merchant + token setup stays consistent,
  // but we upload via HTTP for reliability.
  const createSquareClientForMerchant = makeCreateSquareClientForMerchant({ firestore });

  router.post("/api/update-item-image", requireLogin, upload.single("image"), async (req, res) => {
    try {
      const gtin = (req.body.gtin || "").toString().trim();
      if (!gtin) return res.status(400).json({ ok: false, error: "gtin is required" });

      const file = req.file;
      if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: "image file is required" });
      const normalized = await normalizeImageForSquare({
        buffer: file.buffer,
        filename: file.originalname,
        mimetype: file.mimetype,
      });

      // 1) Find all merchants/items that have this GTIN (from global inventory)
      const invSnap = await firestore.collection("inventory").where("gtin", "==", gtin).get();
      if (invSnap.empty) {
        return res.status(404).json({ ok: false, error: `No inventory rows found for gtin ${gtin}` });
      }

      // merchantId -> itemId set
      const merchantItems = new Map();
      for (const doc of invSnap.docs) {
        const d = doc.data() || {};
        const merchantId = d.merchant_id;
        const itemId = d.item_id;
        if (!merchantId || !itemId) continue;

        if (!merchantItems.has(merchantId)) merchantItems.set(merchantId, new Set());
        merchantItems.get(merchantId).add(itemId);
      }

      let updatedMerchants = 0;
      let skippedMerchants = 0;
      const results = [];
      let firstImageUrl = null;

      // 2) For each merchant: load token/env and upload
      for (const [merchantId, itemIds] of merchantItems.entries()) {
        // Ensure merchant exists / client can be created (your existing auth setup)
        try {
          const c = await createSquareClientForMerchant({ merchantId });
          if (!c) throw new Error("createSquareClientForMerchant returned null/undefined");
        } catch (e) {
          skippedMerchants++;
          results.push({ merchantId, ok: false, error: `Square client create failed: ${e?.message || e}` });
          continue;
        }

        // Pull token/env from merchant doc
        const merchantDoc = await firestore.collection("merchants").doc(merchantId).get();
        const merchant = merchantDoc.exists ? merchantDoc.data() || {} : {};
        const accessToken = merchant.access_token || merchant.accessToken || null;
        const env = merchant.env || process.env.SQUARE_ENV || "production";

        if (!accessToken) {
          skippedMerchants++;
          results.push({ merchantId, ok: false, error: "Missing access_token in merchants/{merchantId}" });
          continue;
        }

        let merchantOk = false;
        const merchantUrls = [];

        for (const itemId of itemIds) {
          try {
            const out = await uploadImageToSquareHttp({
              accessToken,
              env,
              itemId,
              buffer: normalized.buffer,
              filename: normalized.filename,
              mimetype: normalized.mimetype,
            });

            merchantOk = true;
            if (out.imageUrl) merchantUrls.push(out.imageUrl);
            if (!firstImageUrl && out.imageUrl) firstImageUrl = out.imageUrl;

            results.push({
              merchantId,
              itemId,
              ok: true,
              imageUrl: out.imageUrl || null,
              imageId: out.imageObj?.id || null,
            });
          } catch (e) {
            results.push({ merchantId, itemId, ok: false, error: e?.message || String(e) });
          }
        }

        if (merchantOk) updatedMerchants++;
        else skippedMerchants++;

        if (merchantOk) {
          results.push({ merchantId, ok: true, imageUrls: merchantUrls.slice(0, 3) });
        }
      }

      // 3) Persist firstImageUrl to Firestore (optional but recommended)
      const ts = nowIso();
      if (firstImageUrl) {
        await firestore.collection("item_master").doc(gtin).set(
          { image_url: firstImageUrl, updated_at: ts },
          { merge: true }
        );

        // Update all matching inventory docs (global + merchant mirror)
        const batchSize = 400;
        let i = 0;
        const docs = invSnap.docs;

        while (i < docs.length) {
          const batch = firestore.batch();
          const slice = docs.slice(i, i + batchSize);

          for (const doc of slice) {
            const d = doc.data() || {};
            const mId = d.merchant_id || null;

            const imgPatch = {
              image_url: firstImageUrl,
              image_urls: [firstImageUrl],   // ✅ add this
              updated_at: ts,
            };

            batch.set(doc.ref, imgPatch, { merge: true });

            if (mId) {
              const mirrorRef = firestore.collection("merchants").doc(mId).collection("inventory").doc(doc.id);
              batch.set(mirrorRef, imgPatch, { merge: true });
            }
          }

          await batch.commit();
          i += batchSize;
        }
      }

      // If nothing updated, return 400 so UI shows failure
      const allFailed = updatedMerchants === 0;

      return res.status(allFailed ? 400 : 200).json({
        ok: !allFailed,
        gtin,
        firstImageUrl,
        updatedMerchants,
        skippedMerchants,
        results: results.slice(0, 100),
        resultsCount: results.length,
        convertedFromWebp: normalized.convertedFromWebp,
      });
    } catch (e) {
      console.error("update-item-image error", e);
      return res.status(500).json({ ok: false, error: e.message || "Internal error" });
    }
  });

  return router;
};
