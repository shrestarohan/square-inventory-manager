# Square Inventory Manager – Full Documentation

This project manages inventory data across **Google Sheets**, **Firestore**, and **Square POS**, and provides dashboards for:

- Per-item / per-merchant pricing and stock  
- GTIN master price comparison  
- Vendor & unit cost management  

It also contains a set of utility scripts for **cleaning** and **syncing** data between systems.

> This file is the **full internal documentation**. The public-facing overview is in `README.md`.

---

## Table of Contents

1. [Developer Setup](#developer-setup)
   - [Prerequisites](#prerequisites)
   - [Clone & Install](#clone--install)
   - [Firestore Auth](#firestore-auth)
   - [Environment Variables](#environment-variables)
2. [Running the Web App](#running-the-web-app)
   - [Main Routes / Dashboards](#main-routes--dashboards)
3. [NPM Script Commands](#npm-script-commands)
4. [Scripts Overview](#scripts-overview)
   - [1. Sync GTIN Metadata: Google Sheets → Firestore](#1-sync-gtin-metadata-google-sheets--firestore)
   - [2. Proper-case & Normalize Item Names in Firestore](#2-proper-case--normalize-item-names-in-firestore)
   - [3. Sync Cleaned Item Names: Firestore → Square Catalog](#3-sync-cleaned-item-names-firestore--square-catalog)
   - [4. (Optional) Sync SpecsOnline Prices → Firestore](#4-optional-sync-specsonline-prices--firestore)
5. [Dry-Run & Sampling](#dry-run--sampling)
6. [Batching & Safety Notes](#batching--safety-notes)
7. [Scheduling Jobs (Cron / Cloud Scheduler)](#scheduling-jobs-cron--cloud-scheduler)
8. [Common Errors & Fixes](#common-errors--fixes)

---

## Developer Setup

### Prerequisites

- **Node.js**: v18+  
- **npm**: comes with Node  
- **gcloud CLI** (optional, if deploying/running via Google Cloud)

### Clone & Install

```bash
git clone https://github.com/<your-username>/square-inventory-sync.git
cd square-inventory-sync

npm install
```

### Firestore Auth

For **local development**, use a service account key:

1. In Google Cloud Console:
   - Go to **IAM & Admin → Service Accounts**
   - Create or select a service account with Firestore access.
   - Create a **JSON key** and download it.
2. On your machine (or in Cloud Shell if you want explicit auth):

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

In **Cloud Run** and many **Cloud Shell** environments, Application Default Credentials may already be configured, so you might not need this manually.

### Environment Variables

Create a `.env` file at the project root (values are examples):

```env
# Google Sheets – GTIN cost/vendor sheet
COST_SHEET_ID=1MkvR9uwO4xLmB8YKjOrcIad4XQEoNJJyO69pJKb1O4A
COST_SHEET_RANGE=GtinCostVendor!A2:E

# Firestore collection that stores GTIN metadata
ITEM_NAME_COLLECTION=gtinMeta

# Square API
SQUARE_ACCESS_TOKEN=YOUR_SQUARE_ACCESS_TOKEN_HERE
SQUARE_ENV=production    # or sandbox

# Optional flags for dry-run / sampling for scripts
# DRY_RUN=true
# SAMPLE_LIMIT=100
```

> **Important:**  
> - `COST_SHEET_ID` must be **just the Sheet ID**, not the full URL.  
> - `COST_SHEET_RANGE` should point to the cleaned tab that has:  
>   `GTIN`, `SKU`, `Item Name`, `Unit Cost`, `Vendor Name`.

---

## Running the Web App

Typical dev commands (check `package.json` for your exact script names):

```bash
# Start the Express app locally
npm start
# or, if you have a dev script
npm run dev
```

In **Cloud Shell**, you may want:

```bash
PORT=8080 npm start
```

Then use **Web Preview → Port 8080**.

### Main Routes / Dashboards

- `GET /dashboard`
  - Per Item / Per Merchant view
  - Supports merchant selection and filters via the header.
- `GET /dashboard-gtin`
  - GTIN master view, showing prices across locations.
- `GET /dashboard-vendor-costs`
  - Vendor & unit cost management.
  - Uses Firestore `gtinMeta` as source.
  - Supports:
    - Inline editing of `SKU`, `Item Name`, `Vendor Name`, `Unit Cost`.
    - Search via the global `#search` input.
    - Client-side pagination on the table.

The header partial wires:

- **View selector** (`/dashboard`, `/dashboard-gtin`, `/dashboard-vendor-costs`).
- **Search box** that filters the current table.

---

## NPM Script Commands

Ensure these entries exist in `package.json`:

```jsonc
"scripts": {
  "sync:gtin-meta": "node scripts/syncSheetToFirestore.js",
  "proper:item-names": "node scripts/properCaseItemNames.js",
  "sync:gtin-names:square": "node scripts/syncGtinNamesToSquare.js",
  "sync:specs-prices": "node scripts/updateSpecsPrices.js"
}
```

### Quick command reference

```bash
# Sync GTIN / SKU / Item Name / Unit Cost / Vendor from Google Sheets → Firestore
npm run sync:gtin-meta

# Clean and normalize itemName in Firestore (supports DRY_RUN & SAMPLE_LIMIT)
npm run proper:item-names

# Sync cleaned itemName from Firestore → Square Catalog
npm run sync:gtin-names:square

# (Optional) Pull SpecsOnline prices → Firestore
npm run sync:specs-prices
```

---

## Scripts Overview

### 1. Sync GTIN Metadata: Google Sheets → Firestore

**File:** `scripts/syncSheetToFirestore.js`  
**Command:**

```bash
npm run sync:gtin-meta
```

**Purpose:**

- Reads your Google Sheet (e.g. `GtinCostVendor` tab) with columns:
  - `GTIN`, `SKU`, `Item Name`, `Unit Cost`, `Vendor Name`
- Upserts one Firestore document per GTIN into `gtinMeta`:
  - `gtin`
  - `sku`
  - `itemName`
  - `vendorName`
  - `unitCost`
  - `updatedAt`

**Behavior:**

- Uses `COST_SHEET_ID` and `COST_SHEET_RANGE` from `.env`.
- Uses `{ merge: true }` so existing unrelated fields are preserved.

---

### 2. Proper-case & Normalize Item Names in Firestore

**File:** `scripts/properCaseItemNames.js`  
**Command:**

```bash
npm run proper:item-names
```

**Purpose:**

- Cleans and standardizes `itemName` in Firestore before reporting or syncing to Square.

**Collection:**

- Targets `ITEM_NAME_COLLECTION` from `.env` (default: `gtinMeta`).

**Logic:**

1. **Title-case** words:
   - e.g., `HENNESSY VS 750ML` → `Hennessy Vs 750ml` (prior to unit fix).

2. **Normalize specific `ml` sizes**:
   - `50 ml` / `50ML` / `50ml` → `50ML`
   - `100 ml` / `100ML` → `100ML`
   - `200 ml` / `200ML` → `200ML`
   - `375 ml` / `375ML` → `375ML`
   - `355 ml` / `355ML` → `355ML`
   - `750 ml` / `750ML` → `750ML`

3. **Normalize specific `L` sizes**:
   - `1 l` / `1L` / `1l` → `1L`
   - `1.5 l` / `1.5L` / `1.5l` → `1.5L`
   - `1.75 l` / `1.75L` / `1.75l` → `1.75L`

4. **Ounce fixes**:
   - Typo fix: `120z` (any case) → `12oz`
   - Fluid ounces:
     - `16fl oz`, `16 fl oz`, `16 FL OZ` → `16oz`
   - General normalization:
     - `15.20 Oz`, `12 OZ` → `15.20oz`, `12oz`

5. **Metadata**:
   - Sets `itemNameProperUpdatedAt` to `new Date().toISOString()` when `itemName` changes.

**Batching & pagination:**

- Reads Firestore in pages (`READ_PAGE_SIZE = 1000`) using `orderBy('__name__')` + `startAfter(lastDoc)`.
- Writes using `firestore.batch()` with `BATCH_LIMIT = 400` updates per commit.

---

### 3. Sync Cleaned Item Names: Firestore → Square Catalog

**Files:**

- `lib/squareCatalog.js` – Square Catalog helpers
- `scripts/syncGtinNamesToSquare.js` – batch sync script

**Command:**

```bash
npm run sync:gtin-names:square
```

**Purpose:**

- Treat Firestore’s `gtinMeta.itemName` as **source of truth**.
- Find matching Square `ITEM_VARIATION` using `itemVariationData.upc` (GTIN/UPC).
- Update Square variation names when they differ.

**Flow:**

1. Build a **GTIN → variation** map from Square:
   - `listCatalog` on types `ITEM` and `ITEM_VARIATION`.
   - For each `ITEM_VARIATION` with `itemVariationData.upc`, cache it by GTIN.

2. Scan Firestore:
   - For each doc in `ITEM_NAME_COLLECTION` with `gtin` + `itemName`:
     - Find variation via GTIN.
     - Compare `itemVariationData.name` vs Firestore `itemName`.
     - Stage update when they differ.

3. Upsert to Square:
   - Use `catalogApi.batchUpsertCatalogObjects` in batches of 50 objects.
   - Provide id + type + version + updated `itemVariationData.name`.
   - Use idempotency keys per batch.

**Safety:**

- Only writes when names actually differ.
- Supports `DRY_RUN` + `SAMPLE_LIMIT`.

---

### 4. (Optional) Sync SpecsOnline Prices → Firestore

**File:** `scripts/updateSpecsPrices.js`  
**Command:**

```bash
npm run sync:specs-prices
```

**Purpose:**

- For each GTIN in `gtinMeta`:
  - Hit a SpecsOnline search/product URL (if allowed).
  - Parse price from HTML.
  - Store in Firestore:
    - `specsPrice`
    - `specsPriceCurrency` (e.g., `USD`)
    - `specsPriceCheckedAt`

**Warnings:**

- You must confirm that scraping SpecsOnline is allowed by **Terms of Use** and `robots.txt`.
- You must configure:
  - The correct search URL format.
  - A `PRICE_REGEX` that matches their actual HTML structure.

---

## Dry-Run & Sampling

Scripts that support **dry-run**:

- `proper:item-names`
- `sync:gtin-names:square`
- (optionally) `sync:specs-prices`

Use env vars:

- `DRY_RUN=true` → log planned changes, but do not write.
- `SAMPLE_LIMIT=NN` → process only the first `NN` docs.

### Examples

```bash
# Dry run item name cleanup, first 30 docs
DRY_RUN=true SAMPLE_LIMIT=30 npm run proper:item-names

# Dry run Square name sync, first 50 docs
DRY_RUN=true SAMPLE_LIMIT=50 npm run sync:gtin-names:square
```

Remove these env vars to run full updates.

---

## Batching & Safety Notes

### Firestore

- **Reads**:
  - `READ_PAGE_SIZE = 1000` docs per page via `orderBy('__name__')` + `startAfter`.
- **Writes**:
  - Up to `BATCH_LIMIT = 400` updates per `batch.commit()` to stay under the 500 write limit.

### Square

- Uses `batchUpsertCatalogObjects` with small batches (~50 objects).
- Provides idempotency keys to avoid duplicate upserts.

### General Guidance

- Always test logic with `DRY_RUN=true` + `SAMPLE_LIMIT`.
- Prefer `SQUARE_ENV=sandbox` until behavior is verified.

---

## Scheduling Jobs (Cron / Cloud Scheduler)

### Cron on a server / VM

Item-name cleanup every Sunday at 3:00 AM:

```cron
0 3 * * 0 cd /path/to/square-inventory-sync && /usr/bin/npm run proper:item-names >> proper-names.log 2>&1
```

Specs price sync (if allowed) every Sunday at 4:00 AM:

```cron
0 4 * * 0 cd /path/to/square-inventory-sync && /usr/bin/npm run sync:specs-prices >> specs-sync.log 2>&1
```

### Cloud Scheduler → Cloud Run

- Expose an HTTP endpoint (e.g., `/tasks/proper-item-names`) that runs the script function.
- Configure a Cloud Scheduler job to `POST` to that URL with OIDC auth.
- Reuse the same business logic from the script (factor into a shared module).

---

## Common Errors & Fixes

### 1. `Error: listen EADDRINUSE: address already in use :::8080`

**Cause:** Port 8080 already in use (probably an old dev server).

**Fix:**

```bash
# See which process is using port 8080
sudo fuser -n tcp 8080

# Kill it
sudo fuser -k 8080/tcp
```

Or run on a different port:

```bash
PORT=3000 npm start
```

---

### 2. `GaxiosError: Requested entity was not found. (Sheets API 404)`

Usually happens if you passed a full URL into `COST_SHEET_ID`.

**Fix:**

```env
# ❌ Wrong
COST_SHEET_ID=https://docs.google.com/spreadsheets/d/1MkvR9u.../edit?gid=0

# ✅ Correct
COST_SHEET_ID=1MkvR9uwO4xLmB8YKjOrcIad4XQEoNJJyO69pJKb1O4A
```

Make sure `COST_SHEET_RANGE` is something like `GtinCostVendor!A2:E`.

---

### 3. Permission / Auth Errors (Firestore / Sheets / Square)

- Check that you enabled:
  - Firestore API
  - Google Sheets API
- Ensure service account has Firestore read/write and access to the sheet (share the sheet if needed).
- Verify `SQUARE_ACCESS_TOKEN` and `SQUARE_ENV`.

---

This file (`DOCS.md`) is your **full playbook**. For a quick overview or for other developers, refer them to `README.md` and link here for deep details.
