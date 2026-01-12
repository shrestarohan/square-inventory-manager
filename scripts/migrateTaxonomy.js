// scripts/migrateTaxonomy.js
const firestore = require("../lib/firestore");

const MARGIN_BY_CATEGORY = {
  "Vapes - Disposable Vapes": { target: 0.30, floor: 0.20 },
  "Vapes - Pod Systems": { target: 0.35, floor: 0.25 },
  "Vapes - Vape Mods": { target: 0.40, floor: 0.30 },
  "Vapes - Tanks & Atomizers": { target: 0.40, floor: 0.30 },
  "Vapes - Coils & Pods": { target: 0.50, floor: 0.35 },
  "Vapes - E-Liquids": { target: 0.55, floor: 0.40 },
  "Vapes - Batteries & Power": { target: 0.35, floor: 0.25 },
  "Vapes - Vape Accessories": { target: 0.60, floor: 0.45 },
  "Vapes - CBD / Hemp": { target: 0.60, floor: 0.45 },
  "Vapes - Cannabinoids (Delta / THC)": { target: 0.65, floor: 0.50 },
  "Vapes - Glass & Smoking": { target: 0.55, floor: 0.40 },
  "Vapes - Hookah": { target: 0.45, floor: 0.35 },
};

function detectCategory(name = "") {
  const n = name.toLowerCase();

  if (n.includes("disposable") || n.includes("puff") || n.includes("puffs")) return "Disposable Vapes";
  if (n.includes("salt") || n.includes("nic salt")) return "E-Liquids";
  if (n.includes("e-liquid") || n.includes("eliquid") || n.includes("vape juice") || n.includes("juice")) return "E-Liquids";
  if (n.includes("coil") || n.includes("mesh")) return "Coils & Pods";
  if (n.includes("pod")) return "Pod Systems";
  if (n.includes("mod")) return "Vape Mods";
  if (n.includes("tank") || n.includes("atomizer") || n.includes("rda") || n.includes("rta") || n.includes("rdta")) return "Tanks & Atomizers";
  if (n.includes("battery") || n.includes("18650") || n.includes("21700") || n.includes("charger")) return "Batteries & Power";
  if (n.includes("delta") || n.includes("thc") || n.includes("hhc") || n.includes("thc-o") || n.includes("thco")) return "Cannabinoids (Delta / THC)";
  if (n.includes("cbd") || n.includes("hemp")) return "CBD / Hemp";
  if (n.includes("glass") || n.includes("pipe") || n.includes("bong") || n.includes("rig") || n.includes("dab")) return "Glass & Smoking";
  if (n.includes("hookah") || n.includes("shisha") || n.includes("coal")) return "Hookah";

  return "Vape Accessories";
}

function detectNicotine(name = "") {
  const s = name.toLowerCase();

  if (/\b0\s?mg\b|\bzero nic\b|\b0%\b/.test(s)) return "0%";
  if (/\b50\s?mg\b|\b5\s?%\b/.test(s)) return "50mg";
  if (/\b35\s?mg\b|\b3\.5\s?%\b/.test(s)) return "35mg";
  if (/\b25\s?mg\b|\b2\.5\s?%\b/.test(s)) return "25mg";
  if (/\b6\s?mg\b|\b0\.6\s?%\b/.test(s)) return "6%";
  if (/\b3\s?mg\b|\b0\.3\s?%\b/.test(s)) return "3%";
  if (/\b2\s?mg\b|\b0\.2\s?%\b/.test(s)) return "2%";
  return null;
}

function detectFlavorFamily(name = "") {
  const s = name.toLowerCase();
  if (s.includes("menthol") || s.includes("ice") || s.includes("mint")) return "Menthol / Ice";
  if (s.includes("tobacco")) return "Tobacco";
  if (s.includes("custard") || s.includes("cream") || s.includes("vanilla")) return "Cream / Custard";
  if (s.includes("dessert") || s.includes("cake") || s.includes("donut")) return "Dessert";
  if (s.includes("candy") || s.includes("gummy")) return "Candy";
  if (s.includes("coffee") || s.includes("cola") || s.includes("drink")) return "Beverage";
  if (s.includes("strawberry") || s.includes("mango") || s.includes("banana") || s.includes("grape") || s.includes("watermelon") || s.includes("apple")) return "Fruit";
  return null;
}

function detectProductType(name = "", category = "") {
  const s = name.toLowerCase();
  if (s.includes("cbd")) return "CBD";
  if (s.includes("delta-8") || s.includes("d8")) return "Delta-8";
  if (s.includes("delta-9") || s.includes("d9")) return "Delta-9";
  if (s.includes("hhc")) return "HHC";
  if (s.includes("thc-o") || s.includes("thco")) return "THC-O";
  if (category === "E-Liquids" || category === "Disposable Vapes" || category === "Pod Systems") return "Nicotine";
  if (category.includes("Glass") || category.includes("Accessory") || category.includes("Batteries") || category.includes("Coils")) return "Accessory";
  return null;
}

function normalizeSku(sku = "") {
  return sku.toString().trim().toUpperCase().replace(/\s+/g, "-");
}

async function migrateCollection(colRef, { dryRun = true, batchSize = 400 } = {}) {
  let lastDoc = null;
  let updated = 0;

  while (true) {
    let q = colRef.orderBy("__name__").limit(batchSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = firestore.batch();

    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const name = (d.item_name || d.name || "").toString();
      if (!name) continue;

      const category = detectCategory(name);
      const nicotine = detectNicotine(name);
      const flavor = detectFlavorFamily(name);
      const productType = detectProductType(name, category);
      const margins = MARGIN_BY_CATEGORY[category] || { target: null, floor: null };

      const patch = {
        taxonomy: {
          category,
          subcategory: d.taxonomy?.subcategory || null,
          flavor_family: flavor,
          nicotine_strength: nicotine,
          product_type: productType,
          confidence: 0.7,
          source: "rules",
          updated_at: new Date().toISOString(),
        },
        pricing: {
          ...(d.pricing || {}),
          margin_target: margins.target,
          margin_floor: margins.floor,
        },
        sku_meta: {
          ...(d.sku_meta || {}),
          sku_normalized: d.sku ? normalizeSku(d.sku) : null,
          sku_rule_version: "v1",
        },
      };

      if (!dryRun) batch.set(doc.ref, patch, { merge: true });
      updated++;
    }

    if (!dryRun) await batch.commit();
    lastDoc = snap.docs[snap.docs.length - 1];
  }

  return updated;
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1";
  const merchantId = process.env.MERCHANT_ID || null;

  console.log("DRY_RUN =", dryRun);
  console.log("MERCHANT_ID =", merchantId || "(all merchants)");

  // Per-merchant inventories
  if (merchantId) {
    const col = firestore.collection("merchants").doc(merchantId).collection("inventory");
    const n = await migrateCollection(col, { dryRun });
    console.log("Updated merchant inventory docs:", n);
  } else {
    // If you have a global inventory collection too, migrate it:
    // const globalCol = firestore.collection("inventory");
    // await migrateCollection(globalCol, { dryRun });

    const merchantsSnap = await firestore.collection("merchants").get();
    for (const m of merchantsSnap.docs) {
      const col = firestore.collection("merchants").doc(m.id).collection("inventory");
      const n = await migrateCollection(col, { dryRun });
      console.log(`Updated merchants/${m.id}/inventory:`, n);
    }
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
