# Square Inventory Manager

Square Inventory Manager is a Node.js app that keeps product data in sync across:

- **Square POS Catalog**
- **Google Sheets**
- **Firestore**

It also provides web dashboards for:

- Per-item / per-merchant view
- GTIN master price comparison
- Vendor & unit cost management

---

## Features

- 🔄 Sync GTIN, SKU, item name, unit cost, and vendor from Google Sheets → Firestore  
- 🧹 Clean and normalize item names (sizes, units, and formatting) in Firestore  
- 📦 Sync cleaned item names from Firestore → Square Catalog  
- 📊 Web dashboards for inventory, price mismatches, and vendor/cost data  
- 🧪 Safe dry-run mode for all batch scripts

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/<your-username>/square-inventory-sync.git
cd square-inventory-sync
npm install
```

### 2. Configure environment

Create a `.env` file in the project root and add your:

- Firestore project credentials (via service account / default credentials)
- Google Sheets IDs & ranges
- Square API access token

See **[DOCS.md](./DOCS.md)** for full details on all required environment variables.

---

## Running the app

Start the web dashboard locally:

```bash
npm start
# or
npm run dev
```

Then open the printed URL (for example, `http://localhost:8080`).

Main routes:

- `/dashboard` – Per item / per merchant  
- `/dashboard-gtin` – GTIN master price comparison  
- `/dashboard-vendor-costs` – Vendor & unit cost management  

---

## Utility Scripts

Some key scripts (see **[DOCS.md](./DOCS.md)** for full behavior and safety notes):

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

Use `DRY_RUN=true` and `SAMPLE_LIMIT=NN` for safe testing; see **DOCS.md** for examples.

---

# Schedule it to run every night (Cloud Scheduler)

Pick a time (say 2:00 AM Central). That’s America/Chicago timezone.
Run this once from your terminal (in the same GCP project):

```bash
gcloud scheduler jobs create http nightly-inventory-gtin-sync \
  --schedule="0 2 * * *" \
  --time-zone="America/Chicago" \
  --http-method=GET \
  --uri="https://square-inventory-sync-976955084378.us-central1.run.app/tasks/full-nightly-sync"
```

---

## Full Documentation

For detailed setup, script internals, batching, and common error fixes, read:

➡️ **[DOCS.md](./DOCS.md)**

