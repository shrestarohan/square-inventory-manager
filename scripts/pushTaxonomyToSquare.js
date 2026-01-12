// scripts/pushTaxonomyToSquare.js
// ------------------------------------------------------------
// PURPOSE
//   Push Firestore taxonomy fields -> Square Catalog:
//     1) Ensure Square Categories exist (per merchant)
//     2) Ensure Square Catalog Custom Attribute Definitions exist (optional)
//     3) For each inventory doc with Square item_id:
//         - set Square ITEM.categoryId
//         - set Square ITEM custom attributes (subcategory, flavor_family, nicotine_strength, product_type)
//
// USAGE
//   DRY_RUN=1 node scripts/pushTaxonomyToSquare.js
//   DRY_RUN=0 node scripts/pushTaxonomyToSquare.js
//
//   # single merchant
//   MERCHANT_ID=ML... DRY_RUN=0 node scripts/pushTaxonomyToSquare.js
//
// OPTIONAL
//   LIMIT=200          # only process first N items per merchant
//   ONLY_UNSYNCED=1    # only items missing square_taxonomy_synced_at
//   SLEEP_MS=120       # throttle between Square calls
//
// REQUIREMENTS (Firestore)
//   merchants/{merchantId} doc has token in one of these fields:
//     square_access_token OR squareAccessToken
//
//   merchants/{merchantId}/inventory docs should have:
//     item_id (Square item id)  [or square_item_id]
//     taxonomy.category, taxonomy.subcategory, taxonomy.flavor_family,
//     taxonomy.nicotine_strength, taxonomy.product_type
//
// NOTES
//   - If your Square legacy SDK does NOT expose catalogCustomAttributesApi,
//     this script will still set categoryId but will SKIP custom attributes.
// ------------------------------------------------------------

require("../lib/loadEnv");
const firestore = require("../lib/firestore");
const { createSquareClient } = require('../lib/square');

// -------------------------------
// Config: Categories + Attributes
// -------------------------------
const CATEGORY_NAMES = [
  "Vapes - Disposable Vapes",
  "Vapes - Pod Systems",
  "Vapes - Vape Mods",
  "Vapes - Tanks & Atomizers",
  "Vapes - Coils & Pods",
  "Vapes - E-Liquids",
  "Vapes - Batteries & Power",
  "Vapes - Vape Accessories",
  "Vapes - CBD / Hemp",
  "Vapes - Cannabinoids (Delta / THC)",
  "Vapes - Glass & Smoking",
  "Vapes - Hookah",
];

// Catalog Custom Attribute Definitions
// (Dropdowns: enum values must include whatever you plan to set)
const ATTR_DEFS = [
  {
    key: "subcategory",
    name: "Subcategory",
    allowedValues: [
      "Standard Disposable",
      "Rechargeable Disposable",
      "High-Puff Disposable",
      "Zero-Nic Disposable",
      "Freebase Nicotine",
      "Salt Nicotine",
      "Synthetic Nicotine",
      "Zero Nicotine",
      "Replacement Coil",
      "Mesh Coil",
      "Pod Cartridge",
    ],
    allowedObjectTypes: ["ITEM"], // keep item-level for simplicity
  },
  {
    key: "flavor_family",
    name: "Flavor Family",
    allowedValues: [
      "Fruit",
      "Dessert",
      "Candy",
      "Menthol / Ice",
      "Tobacco",
      "Beverage",
      "Cream / Custard",
      "Unflavored",
    ],
    allowedObjectTypes: ["ITEM"],
  },
  {
    key: "nicotine_strength",
    name: "Nicotine Strength",
    allowedValues: ["0%", "2%", "3%", "5%", "6%", "25mg", "35mg", "50mg"],
    allowedObjectTypes: ["ITEM"],
  },
  {
    key: "product_type",
    name: "Product Type",
    allowedValues: ["Nicotine", "CBD", "Delta-8", "Delta-9", "HHC", "THC-O", "Accessory", "Hardware"],
    allowedObjectTypes: ["ITEM"],
  },
];

// -------------------------------
// Helpers
// -------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function idem(prefix, ...parts) {
  const raw = [prefix, ...parts].join("|");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${prefix}-${h.toString(16)}`;
}

function withTimeout(promise, ms, label = "operation") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const CATEGORY_ALIASES = {
  "disposable": "Vapes - Disposable Vapes",
  "disposables": "Vapes - Disposable Vapes",
  "e liquid": "Vapes - E-Liquids",
  "eliquid": "Vapes - E-Liquids",
  "vape juice": "Vapes - E-Liquids",
  "pods": "Vapes - Pod Systems",
  "pod system": "Vapes - Pod Systems",
  "mods": "Vapes - Vape Mods",
  "tanks": "Vapes - Tanks & Atomizers",
  "coils": "Vapes - Coils & Pods",
  "accessories": "Vapes - Vape Accessories",
  "battery": "Vapes - Batteries & Power",
  "batteries": "Vapes - Batteries & Power",
  "cbd": "Vapes - CBD / Hemp",
  "delta": "Vapes - Cannabinoids (Delta / THC)",
  "thc": "Vapes - Cannabinoids (Delta / THC)",
  "glass": "Vapes - Glass & Smoking",
  "hookah": "Vapes - Hookah",
};

function normalizeCategoryName(raw) {
  const s = (raw || "").toString().trim();
  if (!s) return "";
  const key = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return CATEGORY_ALIASES[key] || s; // if already "Vapes - ..." it will pass through
}

async function listAllCatalogObjectsOfType(catalogApi, type) {
  const out = [];
  let cursor = undefined;

  while (true) {
    const resp = await catalogApi.listCatalog(undefined, type, undefined, cursor);
    const objs = resp?.result?.objects || [];
    out.push(...objs);
    cursor = resp?.result?.cursor;
    if (!cursor) break;
  }
  return out;
}

// Ensure categories exist and return map: nameLower -> categoryId
async function ensureCategories({ catalogApi, categoryNames, dryRun }) {
  const existing = await listAllCatalogObjectsOfType(catalogApi, "CATEGORY");
  const byName = new Map(
    existing
      .map((o) => ({ id: o.id, name: o.categoryData?.name || "" }))
      .filter((x) => x.name)
      .map((x) => [x.name.toLowerCase(), x.id])
  );

  const toCreate = [];
  for (const name of categoryNames) {
    if (byName.has(name.toLowerCase())) continue;
    toCreate.push({
      type: "CATEGORY",
      id: `#CAT_${name.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`,
      categoryData: { name },
    });
  }

  if (!toCreate.length) {
    return Object.fromEntries(byName);
  }

  console.log(`  • Need to create ${toCreate.length} categories`);
  console.log(`  • Creating ${toCreate.length} categories in Square...`);
  if (!dryRun) {
    const resp = await withTimeout(
      catalogApi.batchUpsertCatalogObjects({
        idempotencyKey: idem("ensure-cats", "vapes-taxonomy-v1"),
        batches: [{ objects: toCreate }],
      }),
      30000,
      "Square batchUpsertCatalogObjects (categories)"
    );

    const created = (resp?.result?.objects || []).filter((o) => o.type === "CATEGORY");
    console.log(`  • Created/returned categories: ${created.length}`);

    created.forEach((o) => {
      const nm = (o.categoryData?.name || "").toLowerCase();
      if (nm) byName.set(nm, o.id);
    });
  }


  return Object.fromEntries(byName);
}

// Ensure catalog custom attribute definitions (dropdowns)
// If SDK lacks catalogCustomAttributesApi, return false
async function ensureCustomAttributeDefs({ squareClient, dryRun }) {
  const api = squareClient.catalogCustomAttributesApi;
  if (!api) {
    console.log("  • catalogCustomAttributesApi not found in your Square SDK. Skipping attribute definitions.");
    return false;
  }

  for (const def of ATTR_DEFS) {
    try {
      // if exists, retrieve will succeed
      await api.retrieveCatalogCustomAttributeDefinition(def.key);
      // exists
    } catch {
      console.log(`  • Creating attribute def: ${def.key}`);
      if (!dryRun) {
        await api.upsertCatalogCustomAttributeDefinition(def.key, {
          idempotencyKey: idem("attrdef", def.key),
          customAttributeDefinition: {
            key: def.key,
            name: def.name,
            visibility: "VISIBILITY_READ_WRITE_VALUES",
            schema: { type: "string", enum: def.allowedValues },
            allowedObjectTypes: def.allowedObjectTypes,
          },
        });
      }
    }
  }

  return true;
}

function coerceAttrValue(key, value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!v) return null;

  // Enforce enum membership if you want strictness.
  // Here: only set values that exist in our allowed values list.
  const def = ATTR_DEFS.find((d) => d.key === key);
  if (!def) return null;

  const allowed = new Set(def.allowedValues.map((x) => x.toLowerCase()));
  if (!allowed.has(v.toLowerCase())) return null;

  // Use the canonical casing from allowedValues
  const canonical = def.allowedValues.find((x) => x.toLowerCase() === v.toLowerCase());
  return canonical || v;
}

async function setSquareItemCategory({ catalogApi, itemId, categoryId, dryRun }) {
  const retrieve = await catalogApi.retrieveCatalogObject(itemId, true);
  const itemObj = retrieve?.result?.object;
  if (!itemObj || itemObj.type !== "ITEM") throw new Error("Square ITEM not found");

  const curCat = itemObj.itemData?.categoryId || null;
  if (curCat === categoryId) return { changed: false };

  itemObj.itemData = { ...(itemObj.itemData || {}), categoryId };

  if (!dryRun) {
    await catalogApi.upsertCatalogObject({
      idempotencyKey: `item-cat-${itemId}-${Date.now()}`,
      object: itemObj,
    });
  }

  return { changed: true };
}

async function upsertSquareItemAttributes({ squareClient, itemId, attrs, dryRun }) {
  const api = squareClient.catalogCustomAttributesApi;
  if (!api) return { changed: false, skipped: true };

  let changed = false;

  for (const [key, value] of Object.entries(attrs || {})) {
    const v = coerceAttrValue(key, value);
    if (!v) continue;

    changed = true;

    if (!dryRun) {
      await api.upsertCatalogCustomAttribute(itemId, key, {
        idempotencyKey: `attr-${itemId}-${key}-${Date.now()}`,
        customAttribute: { value: v },
      });
    }
  }

  return { changed, skipped: false };
}

// -------------------------------
// Main
// -------------------------------
async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const merchantIdOnly = (process.env.MERCHANT_ID || "").trim() || null;
  const onlyUnsynced = process.env.ONLY_UNSYNCED === "1";
  const limit = Number(process.env.LIMIT || 0) || null;
  const sleepMs = Number(process.env.SLEEP_MS || 120) || 0;

  console.log("DRY_RUN =", dryRun);
  console.log("MERCHANT_ID =", merchantIdOnly || "(all)");
  console.log("ONLY_UNSYNCED =", onlyUnsynced);
  console.log("LIMIT =", limit || "(none)");
  console.log("SLEEP_MS =", sleepMs);

  // Merchants to process
  const merchantDocs = merchantIdOnly
    ? [await firestore.collection("merchants").doc(merchantIdOnly).get()].filter((d) => d.exists)
    : (await firestore.collection("merchants").get()).docs;

  if (!merchantDocs.length) {
    console.log("No merchants found.");
    return;
  }

  for (const mDoc of merchantDocs) {
    const merchantId = mDoc.id;
    console.log("\n==============================");
    console.log("Merchant:", merchantId);

    const merchant = mDoc.data();
    const accessToken =
      merchant.square_access_token ||
      merchant.squareAccessToken ||
      merchant.access_token ||
      merchant.accessToken ||
      merchant.square?.access_token;

    const env = merchant.square_env || merchant.env || merchant.square?.env || "production";

    if (!accessToken) {
      console.log("  • No Square token for merchant. Skipping.");
      continue;
    }

    const squareClient = createSquareClient(accessToken, env);

    const catalogApi = squareClient.catalogApi;

    // Ensure categories + attribute defs (once per merchant)
    const categoryMap = await ensureCategories({
      catalogApi,
      categoryNames: CATEGORY_NAMES,
      dryRun,
    });

    const attrEnabled = await ensureCustomAttributeDefs({ squareClient, dryRun });

    // Load inventory docs
    let q = firestore.collection("merchants").doc(merchantId).collection("inventory");

    if (onlyUnsynced) q = q.where("square_taxonomy_synced_at", "==", null);

    // If you don’t have that field at all, Firestore where == null will match missing fields too.
    // If that causes problems, remove ONLY_UNSYNCED and rely on LIMIT.
    let ok = 0;
    let skippedNoSquareId = 0;
    let skippedNoCategory = 0;
    let failed = 0;
    let changedCount = 0;

    const PAGE_SIZE = Math.min(limit || 500, 500); // tune: 200–500 is safe
    let processed = 0;
    let last = null;

    console.log(`  • Scanning inventory (pageSize=${PAGE_SIZE}${limit ? `, limit=${limit}` : ""})`);

    while (true) {
      let pageQ = q.orderBy("__name__").limit(PAGE_SIZE);
      if (last) pageQ = pageQ.startAfter(last);

      const snap = await pageQ.get();
      if (snap.empty) break;

      for (const d of snap.docs) {
        // Respect LIMIT across pages
        if (limit && processed >= limit) break;

        const data = d.data() || {};
        const gtin = data.gtin || d.id;

        const itemId = (data.item_id || data.square_item_id || "").toString().trim();
        if (!itemId) { skippedNoSquareId++; processed++; continue; }

        const tax = data.taxonomy || {};
        const categoryName = normalizeCategoryName(tax.category);
        if (!categoryName) { skippedNoCategory++; processed++; continue; }

        const categoryId = categoryMap[categoryName.toLowerCase()] || null;
        if (!categoryId) { skippedNoCategory++; processed++; continue; }

        const attrs = {
          subcategory: tax.subcategory || null,
          flavor_family: tax.flavor_family || null,
          nicotine_strength: tax.nicotine_strength || null,
          product_type: tax.product_type || null,
        };

        try {
          const r1 = await setSquareItemCategory({ catalogApi, itemId, categoryId, dryRun });
          const r2 = attrEnabled
            ? await upsertSquareItemAttributes({ squareClient, itemId, attrs, dryRun })
            : { changed: false, skipped: true };

          const anyChanged = !!(r1.changed || r2.changed);
          if (anyChanged) changedCount++;

          if (!dryRun) {
            await d.ref.set(
              {
                square_taxonomy: {
                  category: categoryName,
                  category_id: categoryId,
                  attrs_applied: attrEnabled ? Object.keys(attrs).filter((k) => coerceAttrValue(k, attrs[k])) : [],
                  attrs_supported: !!squareClient.catalogCustomAttributesApi,
                },
                square_taxonomy_synced_at: new Date().toISOString(),
                square_taxonomy_last_result: {
                  ok: true,
                  changed: anyChanged,
                  categoryChanged: r1.changed,
                  attrsChanged: r2.changed,
                  attrsSkipped: r2.skipped,
                },
              },
              { merge: true }
            );
          }

          ok++;
        } catch (e) {
          failed++;
          console.log(`  ❌ ${gtin}: ${e.message}`);
          if (!dryRun) {
            await d.ref.set(
              { square_taxonomy_last_result: { ok: false, error: e.message, ts: new Date().toISOString() } },
              { merge: true }
            );
          }
        }

        processed++;
        if (sleepMs) await sleep(sleepMs);
      }

      last = snap.docs[snap.docs.length - 1];
      if (limit && processed >= limit) break;
    }

    console.log("  • Results:");
    console.log("    ok:", ok);
    console.log("    changed:", changedCount);
    console.log("    skipped (no Square item_id):", skippedNoSquareId);
    console.log("    skipped (no category/mapping):", skippedNoCategory);
    console.log("    failed:", failed);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
