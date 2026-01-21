/**
 * scripts/copyImagesAcrossMerchants.js
 * ============================================================
 * PURPOSE
 *   If an image exists for a GTIN in ANY merchant's inventory,
 *   copy it to other merchants that have the same GTIN but no image,
 *   by uploading the image into each merchant's Square catalog and
 *   attaching it to the merchant's ITEM.
 *
 * USAGE
 *   DRY_RUN=1 node scripts/copyImagesAcrossMerchants.js
 *   DRY_RUN=0 node scripts/copyImagesAcrossMerchants.js
 *
 * FILTERING
 *   GTIN=0081234567890 DRY_RUN=1 node scripts/copyImagesAcrossMerchants.js
 *   GTINS=0081...,0001... DRY_RUN=1 node scripts/copyImagesAcrossMerchants.js
 *
 *
 * OPTIONAL ENVS
 *   SQUARE_ENV=sandbox|production   (default sandbox)
 *   LIMIT_GTINS=200                (limit processing)
 *   LIMIT_PER_MERCHANT=200         (max items updated per merchant)
 */

require("../lib/loadEnv"); // adjust relative path

const singleGtin = (process.env.GTIN || '').trim();
const gtinsList = (process.env.GTINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const filterGtins = [
  ...(singleGtin ? [singleGtin] : []),
  ...gtinsList,
];

// If filter is provided, we must not run "scan all"
const hasFilter = filterGtins.length > 0;

console.log('[copyImagesAcrossMerchants] filters:', { singleGtin, gtinsList, filterGtins });

const firestore = require("../lib/firestore");
const { createSquareClient, squareBaseUrl } = require("../lib/square"); // ✅ use your lib

const DRY_RUN = String(process.env.DRY_RUN || "0") === "1";
const SQUARE_ENV = process.env.SQUARE_ENV || "sandbox";
const LIMIT_GTINS = Number(process.env.LIMIT_GTINS || "0"); // 0 = no limit
const LIMIT_PER_MERCHANT = Number(process.env.LIMIT_PER_MERCHANT || "0"); // 0 = no limit

function pickFirstImageUrl(d) {
  if (!d) return null;
  const u = d.image_urls;
  if (Array.isArray(u) && u.length) return String(u[0] || "").trim() || null;
  if (typeof u === "string" && u.trim()) return u.trim();
  return null;
}

function hasImage(d) {
  const u = pickFirstImageUrl(d);
  return !!u;
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Download image bytes from a URL (must be publicly reachable).
 * Node 18+ has global fetch (you’re on Node 24).
 */
async function downloadImage(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download image (${res.status}) from ${url}`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const arr = await res.arrayBuffer();
  const buf = Buffer.from(arr);
  return { buf, contentType };
}

/**
 * Upload catalog image to Square for a merchant using multipart:
 * POST /v2/catalog/images
 *
 * Square expects:
 *   - form field "file" (binary image)
 *   - form field "request" (json string with required "image" object)
 *
 * Ref: Square CreateCatalogImage example (uses -F file=... and request.image...) :contentReference[oaicite:1]{index=1}
 */
async function uploadCatalogImage({ accessToken, env, itemId, filename, contentType, fileBuffer }) {
  const base = squareBaseUrl(env);
  const url = `${base}/v2/catalog/images`;

  const form = new FormData();

  // ✅ required JSON part: includes "image" object
  const requestJson = {
    idempotency_key: `img-${itemId}-${Date.now()}`,
    object_id: itemId, // attach to ITEM
    image: {
      id: "#TEMP_ID",
      type: "IMAGE",
      image_data: {
        caption: `GTIN image for ${itemId}`,
      },
    },
  };

  form.append(
    "request",
    new Blob([JSON.stringify(requestJson)], { type: "application/json" })
  );

  // ✅ required binary part name is "file" (NOT "image")
  form.append(
    "file",
    new Blob([fileBuffer], { type: contentType }),
    filename || `image-${itemId}.jpg`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      // Optional but recommended if you set it elsewhere:
      // "Square-Version": "2025-10-16",
      // IMPORTANT: do NOT set Content-Type; fetch will add boundary.
    },
    body: form,
  });

  const json = await resp.json().catch(() => null);

  if (!resp.ok) {
    const msg = json?.errors ? JSON.stringify(json.errors) : JSON.stringify(json);
    throw new Error(`Square createCatalogImage failed (${resp.status}): ${msg}`);
  }

  const imageObj = json?.image || json?.catalog_object || json?.catalogObject;
  const imageId = imageObj?.id || null;
  const imageUrl = imageObj?.image_data?.url || imageObj?.imageData?.url || null;

  if (!imageId) {
    throw new Error(`Square createCatalogImage returned no image id: ${JSON.stringify(json)}`);
  }

  return { imageId, imageUrl, raw: json };
}

/**
 * Attach imageId to ITEM.imageIds (retrieve item, update imageIds, upsert).
 */
async function attachImageToItem({ client, itemId, imageId }) {
  const itemRes = await client.catalogApi.retrieveCatalogObject(itemId, true);
  const itemObj = itemRes?.result?.object;
  if (!itemObj || itemObj.type !== "ITEM") {
    throw new Error(`Catalog object ${itemId} is not an ITEM`);
  }

  itemObj.itemData = itemObj.itemData || {};
  const cur = Array.isArray(itemObj.itemData.imageIds) ? itemObj.itemData.imageIds : [];
  if (!cur.includes(imageId)) cur.push(imageId);
  itemObj.itemData.imageIds = cur;

  await client.catalogApi.upsertCatalogObject({
    idempotencyKey: `attach-img-${itemId}-${imageId}-${Date.now()}`,
    object: itemObj,
  });

  return true;
}

/**
 * Build map: gtin -> { url, merchantId, itemId }
 * from master inventory collection ('inventory').
 */
async function buildGtinToSourceImageMap() {
  console.log("🔎 Scanning master inventory to find source images per GTIN...");

  // If filtering, only allow these GTINs into the map
  const allow = hasFilter ? new Set(filterGtins) : null;

  const gtinMap = new Map(); // gtin -> { url, merchantId, itemId }
  const PAGE = 800;
  let last = null;
  let scanned = 0;

  while (true) {
    let q = firestore
      .collection("inventory")
      .orderBy("__name__")
      .select("gtin", "merchant_id", "item_id", "image_urls")
      .limit(PAGE);

    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data() || {};
      const gtin = safeStr(d.gtin);
      if (!gtin) continue;

      // ✅ If user provided GTIN/GTINS, ignore everything else
      if (allow && !allow.has(gtin)) continue;

      if (gtinMap.has(gtin)) continue;

      const url = pickFirstImageUrl(d);
      if (!url) continue;

      gtinMap.set(gtin, {
        url,
        merchantId: safeStr(d.merchant_id),
        itemId: safeStr(d.item_id),
      });

      // ✅ If filtering, stop as soon as we got all requested GTINs (or at least one GTIN)
      if (allow && gtinMap.size >= allow.size) {
        console.log(`✅ Found all requested GTINs in master inventory. stopping scan.`);
        return gtinMap;
      }

      if (!allow && LIMIT_GTINS > 0 && gtinMap.size >= LIMIT_GTINS) {
        console.log(`🧪 LIMIT_GTINS hit: ${LIMIT_GTINS}`);
        return gtinMap;
      }
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  console.log(`✅ Scanned ${scanned} master docs. Found ${gtinMap.size} GTINs with a source image.`);
  return gtinMap;
}


/**
 * For a merchant, find items (by item_id) that need images:
 * - have gtin
 * - source image exists for that gtin
 * - merchant inventory doc has no image_urls
 */
async function findMerchantItemsNeedingImages({ merchantId, gtinMap }) {
  const invRef = firestore.collection("merchants").doc(merchantId).collection("inventory");
  const PAGE = 800;

  // ✅ extra guard: if filter is set, only allow those GTINs to be considered
  const allow = hasFilter ? new Set(filterGtins) : null;

  let last = null;
  const needByItemId = new Map();

  while (true) {
    let q = invRef
      .orderBy("__name__")
      .select("gtin", "item_id", "image_urls")
      .limit(PAGE);

    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const gtin = safeStr(d.gtin);
      const itemId = safeStr(d.item_id);

      if (!gtin || !itemId) continue;

      // ✅ if filtering, ignore other GTINs
      if (allow && !allow.has(gtin)) continue;

      if (hasImage(d)) continue;

      const src = gtinMap.get(gtin);
      if (!src?.url) continue;

      if (!needByItemId.has(itemId)) {
        needByItemId.set(itemId, { gtin, sourceUrl: src.url });
        if (LIMIT_PER_MERCHANT > 0 && needByItemId.size >= LIMIT_PER_MERCHANT) break;
      }
    }

    last = snap.docs[snap.docs.length - 1];
    if (LIMIT_PER_MERCHANT > 0 && needByItemId.size >= LIMIT_PER_MERCHANT) break;
    if (snap.size < PAGE) break;
  }

  return needByItemId;
}


/**
 * Update Firestore image_urls for all docs under:
 * - master inventory where merchant_id==merchantId and item_id==itemId
 * - merchant subcollection inventory where item_id==itemId
 */
async function updateFirestoreImages({ merchantId, itemId, imageUrl }) {
  const nowIso = new Date().toISOString();
  const BATCH = 400;

  // master inventory docs for that merchant+item
  const masterQ = firestore
    .collection("inventory")
    .where("merchant_id", "==", merchantId)
    .where("item_id", "==", itemId);

  // merchant inventory docs
  const merchQ = firestore
    .collection("merchants")
    .doc(merchantId)
    .collection("inventory")
    .where("item_id", "==", itemId);

  async function patchQuery(query) {
    let last = null;
    let updated = 0;

    while (true) {
      let q = query.orderBy("__name__").limit(BATCH);
      if (last) q = q.startAfter(last);

      const snap = await q.get();
      if (snap.empty) break;

      const batch = firestore.batch();
      snap.docs.forEach((doc) => {
        batch.set(
          doc.ref,
          {
            image_urls: [imageUrl],
            updated_at: nowIso,
          },
          { merge: true }
        );
      });

      await batch.commit();
      updated += snap.size;

      last = snap.docs[snap.docs.length - 1];
      if (snap.size < BATCH) break;
    }

    return updated;
  }

  const masterUpdated = await patchQuery(masterQ);
  const merchUpdated = await patchQuery(merchQ);

  return { masterUpdated, merchUpdated };
}

/*
async function main() {
  console.log(`\n🖼️  Propagate Item Images Across Merchants`);
  console.log(`   env=${SQUARE_ENV} dryRun=${DRY_RUN} limitGtins=${LIMIT_GTINS || "none"} limitPerMerchant=${LIMIT_PER_MERCHANT || "none"}\n`);

  // make sure app.js sets this, but script can also just use imported firestore
  // (no req.app.locals here)

  const merchantsSnap = await firestore.collection("merchants").get();
  const merchants = merchantsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  console.log(`👥 Merchants: ${merchants.length}`);

  const gtinMap = await buildGtinToSourceImageMap();
  // ✅ If GTIN filter provided, reduce gtinMap to only those keys
  if (hasFilter) {
    const filtered = new Map();
    for (const g of filterGtins) {
      if (gtinMap.has(g)) filtered.set(g, gtinMap.get(g));
    }
    console.log(`🔎 Applying GTIN filter: ${filterGtins.join(", ")} -> ${filtered.size} GTIN(s) with source image`);
    gtinMap.clear();
    for (const [k, v] of filtered.entries()) gtinMap.set(k, v);
  }

  if (!gtinMap.size) {
    console.log("No source images found in master inventory. Nothing to do.");
    return;
  }

  let totalPlanned = 0;
  let totalUploaded = 0;
  let totalAttached = 0;
  let totalFirestorePatched = 0;
  let totalErrors = 0;

  for (const m of merchants) {
    const merchantId = m.id;
    const merchantName = m.business_name || merchantId;
    const accessToken = m.access_token;
    const env = m.env || SQUARE_ENV;

    if (!accessToken) {
      console.log(`\n⚠️  Skip merchant ${merchantName} (${merchantId}): no access_token`);
      continue;
    }

    console.log(`\n🏪 ${merchantName} (${merchantId}) scanning for missing images...`);
    const needByItemId = await findMerchantItemsNeedingImages({ merchantId, gtinMap });

    const itemIds = Array.from(needByItemId.keys());
    if (!itemIds.length) {
      console.log(`   ✅ No missing images to fill.`);
      continue;
    }

    console.log(`   👉 Needs images for ${itemIds.length} ITEMS`);
    totalPlanned += itemIds.length;

    const client = createSquareClient(accessToken, env);

    for (const itemId of itemIds) {
      const { gtin, sourceUrl } = needByItemId.get(itemId);

      try {
        console.log(`   • itemId=${itemId} gtin=${gtin} source=${sourceUrl}`);

        if (DRY_RUN) continue;

        // 1) download source image
        const { buf, contentType } = await downloadImage(sourceUrl);

        // 2) upload into this merchant’s catalog, attached to ITEM
        const filename = `gtin-${gtin || "unknown"}-${Date.now()}.jpg`;
        const { imageId, imageUrl } = await uploadCatalogImage({
          accessToken,
          env,
          itemId,
          filename,
          contentType,
          fileBuffer: buf,
        });
        totalUploaded++;

        // 3) attach imageId to item imageIds (sometimes upload already associates, but we enforce)
        await attachImageToItem({ client, itemId, imageId });
        totalAttached++;

        // 4) patch Firestore so your UI shows it immediately
        const finalUrl = imageUrl || sourceUrl; // prefer Square-hosted if returned
        const patched = await updateFirestoreImages({ merchantId, itemId, imageUrl: finalUrl });
        totalFirestorePatched += (patched.masterUpdated + patched.merchUpdated);

        // small pause to avoid rate limiting bursts
        await sleep(120);
      } catch (e) {
        totalErrors++;
        console.error(`     ❌ Failed itemId=${itemId} (${merchantId}):`, e.message || e);
        // keep going
      }
    }
  }

  console.log(`\n✅ Done.`);
  console.log(`   planned items: ${totalPlanned}`);
  console.log(`   uploaded images: ${totalUploaded}`);
  console.log(`   attached to items: ${totalAttached}`);
  console.log(`   firestore docs patched: ${totalFirestorePatched}`);
  console.log(`   errors: ${totalErrors}\n`);
}*/

async function processOneGtin({ gtin, merchants }) {
  console.log(`\n==============================`);
  console.log(`🔎 Processing GTIN=${gtin}`);
  console.log(`==============================`);

  // Force map to contain only this gtin (your existing code expects gtinMap)
  process.env.GTIN = gtin;

  const gtinMap = await buildGtinToSourceImageMap();
  if (!gtinMap.size) {
    console.log(`❌ No source image found for GTIN=${gtin}`);
    return { planned: 0, uploaded: 0, attached: 0, patched: 0, errors: 0 };
  }

  let planned = 0, uploaded = 0, attached = 0, patched = 0, errors = 0;

  for (const m of merchants) {
    const merchantId = m.id;
    const merchantName = m.business_name || merchantId;

    const accessToken = (m.access_token || "").trim();   // ✅ guard empty string
    const env = (m.env || SQUARE_ENV || "sandbox").trim();

    if (!accessToken) {
      console.log(`\n⚠️  Skip merchant ${merchantName} (${merchantId}): no access_token`);
      continue;
    }

    console.log(`\n🏪 ${merchantName} (${merchantId}) scanning for missing images for GTIN ${gtin}...`);

    const needByItemId = await findMerchantItemsNeedingImages({ merchantId, gtinMap });
    const itemIds = Array.from(needByItemId.keys());
    if (!itemIds.length) {
      console.log(`   ✅ No missing images to fill for this GTIN.`);
      continue;
    }

    console.log(`   👉 Needs images for ${itemIds.length} ITEMS`);
    planned += itemIds.length;

    const client = createSquareClient(accessToken, env);

    for (const itemId of itemIds) {
      const { gtin: g, sourceUrl } = needByItemId.get(itemId);

      try {
        console.log(`   • itemId=${itemId} gtin=${g} source=${sourceUrl}`);
        if (DRY_RUN) continue;

        const { buf, contentType } = await downloadImage(sourceUrl);

        const filename = `gtin-${g || "unknown"}-${Date.now()}.jpg`;
        const { imageId, imageUrl } = await uploadCatalogImage({
          accessToken,
          env,
          itemId,
          filename,
          contentType,
          fileBuffer: buf,
        });
        uploaded++;

        await attachImageToItem({ client, itemId, imageId });
        attached++;

        const finalUrl = imageUrl || sourceUrl;
        const p = await updateFirestoreImages({ merchantId, itemId, imageUrl: finalUrl });
        patched += p.masterUpdated + p.merchUpdated;

        await sleep(120);
      } catch (e) {
        errors++;
        console.error(`     ❌ Failed itemId=${itemId} (${merchantId}):`, e.message || e);
      }
    }
  }

  console.log(`\n📦 GTIN=${gtin} summary: planned=${planned} uploaded=${uploaded} attached=${attached} patched=${patched} errors=${errors}`);
  return { planned, uploaded, attached, patched, errors };
}

async function main() {
  console.log(`\n🖼️  Propagate Item Images Across Merchants (ALL GTINs, sequential)`);
  console.log(`   env=${SQUARE_ENV} dryRun=${DRY_RUN} limitGtins=${LIMIT_GTINS || "none"} limitPerMerchant=${LIMIT_PER_MERCHANT || "none"}\n`);

  // guard against empty string creds env causing plugin errors
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS === "") {
    console.warn("⚠️ GOOGLE_APPLICATION_CREDENTIALS is empty string; unsetting.");
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  const merchantsSnap = await firestore.collection("merchants").get();
  const merchants = merchantsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  console.log(`👥 Merchants: ${merchants.length}`);

  // 1) Build the GTIN list once (ALL GTINs that have a source image)
  //    This returns a map, but we only use its keys as our "work queue".
  const gtinMapAll = await buildGtinToSourceImageMap(); // respects LIMIT_GTINS
  const gtinQueue = Array.from(gtinMapAll.keys());

  if (!gtinQueue.length) {
    console.log("No source images found in master inventory. Nothing to do.");
    return;
  }

  console.log(`\n🧾 GTINs to process: ${gtinQueue.length} (sequential, one at a time)\n`);

  let totals = { planned: 0, uploaded: 0, attached: 0, patched: 0, errors: 0 };

  // 2) Process one GTIN at a time
  for (const gtin of gtinQueue) {
    const r = await processOneGtin({ gtin, merchants });
    totals.planned += r.planned;
    totals.uploaded += r.uploaded;
    totals.attached += r.attached;
    totals.patched += r.patched;
    totals.errors += r.errors;
  }

  console.log(`\n✅ Done (ALL GTINs sequential).`);
  console.log(`   planned items: ${totals.planned}`);
  console.log(`   uploaded images: ${totals.uploaded}`);
  console.log(`   attached to items: ${totals.attached}`);
  console.log(`   firestore docs patched: ${totals.patched}`);
  console.log(`   errors: ${totals.errors}\n`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
