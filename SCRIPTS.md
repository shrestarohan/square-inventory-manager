# Square Inventory Manager – Scripts Runbook

This file is a **quick runbook** for all the important scripts and how/when to run them.

For full details, see **DOCS.md**. For a high-level overview, see **README.md**.

---

## Environment Prereqs

Before running any script:

- Ensure `.env` is configured (see DOCS.md).
- Ensure Firestore credentials are available:
  - Locally: `export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`
  - Cloud Shell / Cloud Run: usually already set.
- Optional safety flags:
  - `DRY_RUN=true` — log what would happen, no writes.
  - `SAMPLE_LIMIT=NN` — only process the first `NN` docs.

---

## 1. Sync GTIN Metadata (Sheets → Firestore)

**Script:** `scripts/syncSheetToFirestore.js`  
**NPM command:**

```bash
npm run sync:gtin-meta
```

**What it does:**

- Reads GTIN, SKU, Item Name, Unit Cost, Vendor Name from Google Sheets.
- Upserts documents into Firestore collection `gtinMeta`:
  - `gtin`, `sku`, `itemName`, `vendorName`, `unitCost`, `updatedAt`.

**When to run:**

- Whenever you update your **Google Sheets cost/vendor data** and want Firestore updated.
- Typically:
  - After receiving updated price lists.
  - Before running reporting or Square sync.

---

## 2. Clean & Normalize Item Names (Firestore)

**Script:** `scripts/properCaseItemNames.js`  
**NPM command:**

```bash
npm run proper:item-names
```

**What it does:**

- Reads docs from `ITEM_NAME_COLLECTION` (default `gtinMeta`).
- Applies:
  - Title-casing to item names.
  - Size/unit normalization:
    - `50 ml` → `50ML`, `750 ml` → `750ML`
    - `1.75 l` → `1.75L`, etc.
    - `16fl oz` → `16oz`, `120z` → `12oz`, etc.
- Writes updated `itemName` and `itemNameProperUpdatedAt`.

**Safe test (dry run):**

```bash
DRY_RUN=true SAMPLE_LIMIT=30 npm run proper:item-names
DRY_RUN=true SAMPLE_LIMIT=200 ITEM_NAME_COLLECTION=merchants/ML1AH5AM3K151/inventory npm run proper:item-names
DRY_RUN=true SAMPLE_LIMIT=200 ITEM_NAME_COLLECTION=merchants/MLRE062EYSN7E/inventory npm run proper:item-names
DRY_RUN=true SAMPLE_LIMIT=200 ITEM_NAME_COLLECTION=merchants/MLTW51AKET6TD/inventory npm run proper:item-names
ITEM_NAME_COLLECTION=merchants/ML1AH5AM3K151/inventory npm run proper:item-names
```

**Typical schedule:**

- **Weekly**, or after large imports into Firestore.

**Prod run:**

```bash
npm run proper:item-names
```

---

## 3. Sync Cleaned Item Names (Firestore → Square)

**Script:** `scripts/syncGtinNamesToSquare.js`  
**NPM command:**

```bash
npm run sync:gtin-names:square
```

**What it does:**

- Builds a map of GTIN → Square Item Variation using `itemVariationData.upc`.
- Reads Firestore `gtinMeta` and compares:
  - Firestore `itemName` vs Square variation name.
- Updates Square variation names where they differ using `batchUpsertCatalogObjects`.

**Safe test (dry run):**

```bash
DRY_RUN=true SAMPLE_LIMIT=50 npm run sync:gtin-names:square
```

**Typical schedule:**

- After:
  - Running `sync:gtin-meta` (Sheets → Firestore)
  - Running `proper:item-names` (cleanup)
- Often **weekly** or after bulk catalog adjustments.

**Prod run:**

```bash
npm run sync:gtin-names:square
```

> Recommended: test first against Square **sandbox** (`SQUARE_ENV=sandbox`) before running on production.

---

## 4. (Optional) Sync SpecsOnline Prices → Firestore

**Script:** `scripts/updateSpecsPrices.js`  
**NPM command:**

```bash
npm run sync:specs-prices
```

**What it does:**

- For each GTIN in Firestore:
  - Looks up the matching product on `specsonline.com` (if allowed).
  - Parses price from HTML.
  - Writes `specsPrice`, `specsPriceCurrency`, `specsPriceCheckedAt`.

**Important:**  
Only use this if allowed by SpecsOnline’s **Terms of Use** and `robots.txt`.

**Safe test (dry run):**

If the script is written to support dry run:

```bash
DRY_RUN=true SAMPLE_LIMIT=20 npm run sync:specs-prices
```

**Typical schedule:**

- **Weekly**, e.g., every Sunday night, if you want an external reference price snapshot.

**Prod run:**

```bash
npm run sync:specs-prices
```

---

## 5. Suggested Weekly Workflow

Example Sunday night automation (in cron or Cloud Scheduler):

1. **Sync from Google Sheets → Firestore**

   ```bash
   npm run sync:gtin-meta
   ```

2. **Clean & normalize names in Firestore**

   ```bash
   npm run proper:item-names
   #Patan
   ITEM_NAME_COLLECTION="merchants/ML1AH5AM3K151/inventory" node scripts/properCaseItemNames.js
   #Amigo
   ITEM_NAME_COLLECTION="merchants/MLRE062EYSN7E/inventory" node scripts/properCaseItemNames.js
   #Thamel
   ITEM_NAME_COLLECTION="merchants/MLTW51AKET6TD/inventory" node scripts/properCaseItemNames.js
   ```

3. **Update Square catalog names**

   ```bash
   npm run sync:gtin-names:square
   ```

4. **(Optional) Refresh SpecsOnline reference prices**

   ```bash
   npm run sync:specs-prices
   ```

5. **(Optional) Refresh item name only to Square from Firestore reference prices**

   ```bash
   MERCHANT_ID=MERCHANT_DOC_ID DRY_RUN=true SAMPLE_LIMIT=50 npm run sync:item-names-to-square
   MERCHANT_ID=MERCHANT_DOC_ID npm run sync:item-names-to-square
   MERCHANT_ID=ML1AH5AM3K151 npm run sync:item-names-to-square
   MERCHANT_ID=MLRE062EYSN7E npm run sync:item-names-to-square
   MERCHANT_ID=MLTW51AKET6TD npm run sync:item-names-to-square


   ```

5. **(Optional) Cleanup column name itemName that was created by mistake**

   ```bash
   MERCHANT_ID=ML1AH5AM3K151 npm run cleanup:itemName-field
   MERCHANT_ID=ML1AH5AM3K151 DRY_RUN=false npm run cleanup:itemName-field
   ```

5. **(Optional) Sync inventory DB from Sqaure to Firestore**

  5a. Sync all merchants
   ```bash
   npm run sync:inventory
   ```

  5b. Sync one merchant only
   ```bash
   MERCHANT_ID=ML1AH5AM3K151 npm run sync:inventory
   ```

---

## 6. Cron Examples

Run item-name cleanup every Sunday at 3 AM:

```cron
0 3 * * 0 cd /path/to/square-inventory-sync && /usr/bin/npm run proper:item-names >> proper-names.log 2>&1
```

Run Specs price sync every Sunday at 4 AM:

```cron
0 4 * * 0 cd /path/to/square-inventory-sync && /usr/bin/npm run sync:specs-prices >> specs-sync.log 2>&1
```

You can adapt similar lines for `sync:gtin-meta` and `sync:gtin-names:square`.

---

## 7. Quick Troubleshooting

- **Port already in use (`EADDRINUSE: :::8080`)**  
  Kill the old process or run on a different port:

  ```bash
  sudo fuser -k 8080/tcp
  PORT=3000 npm start
  ```

- **Sheets 404 / `Requested entity was not found`**  
  Make sure `COST_SHEET_ID` is **just the sheet ID**, not the full URL.

- **Permission errors (Firestore/Sheets)**  
  Check:
  - Service account permissions.
  - APIs enabled (Firestore, Sheets).
  - Sheet shared with service account email if needed.

For deeper explanations, refer back to **DOCS.md**.

