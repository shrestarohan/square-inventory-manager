const express = require('express');
const multer = require('multer');
const FormData = require('form-data');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

function squareBaseUrl(env) {
  return env === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com';
}

// Upload image to Square and attach to ITEM (object_id = itemId)
async function uploadImageToSquare({ accessToken, env, itemId, buffer, filename, mimetype }) {
  const url = `${squareBaseUrl(env)}/v2/catalog/images`;

  // Square expects multipart:
  // - file (binary)
  // - request (json)
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'image.jpg', contentType: mimetype || 'image/jpeg' });

  const bodyRequest = {
    idempotency_key: `img-${itemId}-${Date.now()}`,
    object_id: itemId, // attach to ITEM
  };
  form.append('request', JSON.stringify(bodyRequest), { contentType: 'application/json' });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.detail || data?.errors?.[0]?.code || resp.statusText;
    throw new Error(`Square image upload failed: ${msg}`);
  }

  // data.image = CatalogObject (type IMAGE) or similar
  // We'll try to pull URL defensively.
  const imageObj = data?.image || data?.catalog_object || null;
  const imageUrl =
    imageObj?.image_data?.url ||
    imageObj?.imageData?.url ||
    imageObj?.image_data?.url ||
    null;

  return { imageObj, imageUrl };
}

module.exports = function buildItemImagesRouter({ firestore, requireLogin }) {
  // POST /api/update-item-image (multipart form-data)
  router.post('/api/update-item-image', requireLogin, upload.single('image'), async (req, res) => {
    try {
      const gtin = (req.body.gtin || '').trim();
      if (!gtin) return res.status(400).json({ ok: false, error: 'gtin is required' });

      const file = req.file;
      if (!file?.buffer) return res.status(400).json({ ok: false, error: 'image file is required' });

      // 1) Find all merchants/items that have this GTIN
      const invSnap = await firestore.collection('inventory').where('gtin', '==', gtin).get();
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

      // 2) For each merchant: upload image to Square + attach to each itemId
      for (const [merchantId, itemIds] of merchantItems.entries()) {
        const merchantDoc = await firestore.collection('merchants').doc(merchantId).get();
        if (!merchantDoc.exists) {
          skippedMerchants++;
          results.push({ merchantId, ok: false, error: 'Merchant doc missing' });
          continue;
        }

        const merchant = merchantDoc.data() || {};
        const accessToken = merchant.access_token;
        const env = merchant.env || 'sandbox';

        if (!accessToken) {
          skippedMerchants++;
          results.push({ merchantId, ok: false, error: 'Missing access_token' });
          continue;
        }

        let merchantOk = false;
        const merchantUrls = [];

        for (const itemId of itemIds) {
          try {
            const out = await uploadImageToSquare({
              accessToken,
              env,
              itemId,
              buffer: file.buffer,
              filename: file.originalname,
              mimetype: file.mimetype,
            });

            merchantOk = true;
            if (out.imageUrl) merchantUrls.push(out.imageUrl);
            if (!firstImageUrl && out.imageUrl) firstImageUrl = out.imageUrl;
          } catch (e) {
            results.push({ merchantId, itemId, ok: false, error: e.message });
          }
        }

        if (merchantOk) {
          updatedMerchants++;
          results.push({ merchantId, ok: true, imageUrls: merchantUrls.slice(0, 3) });
        } else {
          skippedMerchants++;
        }
      }

      // 3) Persist image url to Firestore (optional but recommended)
      // Store at item_master and propagate into inventory docs so dashboards can show quickly.
      const nowIso = new Date().toISOString();
      if (firstImageUrl) {
        await firestore.collection('item_master').doc(gtin).set(
          { image_url: firstImageUrl, updated_at: nowIso },
          { merge: true }
        );

        // Update all matching inventory docs (master + merchant mirror)
        // Do in batches
        const batchSize = 400;
        let i = 0;
        const docs = invSnap.docs;

        while (i < docs.length) {
          const batch = firestore.batch();
          const slice = docs.slice(i, i + batchSize);

          for (const doc of slice) {
            const d = doc.data() || {};
            const merchantId = d.merchant_id || null;

            batch.set(doc.ref, { image_url: firstImageUrl, updated_at: nowIso }, { merge: true });

            if (merchantId) {
              const mirrorRef = firestore.collection('merchants').doc(merchantId).collection('inventory').doc(doc.id);
              batch.set(mirrorRef, { image_url: firstImageUrl, updated_at: nowIso }, { merge: true });
            }
          }

          await batch.commit();
          i += batchSize;
        }
      }

      res.json({
        ok: true,
        gtin,
        firstImageUrl,
        updatedMerchants,
        skippedMerchants,
        results: results.slice(0, 50),
        resultsCount: results.length,
      });
    } catch (e) {
      console.error('update-item-image error', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
