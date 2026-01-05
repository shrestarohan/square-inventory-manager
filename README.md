# Project Overview

square-inventory-sync is a Node.js application that coordinates inventory and catalog data between Firestore and Square. The repository contains an Express app, a collection of maintenance and sync scripts, route handlers for both API and UI pages, and helper libraries for Firestore and environment handling. The project is built to run locally (development), in Docker, and in Google Cloud Run (including Cloud Run jobs).

This README documents the code layout, environment configuration, common developer workflows, how to run cloud jobs, route surface area, and troubleshooting tips based strictly on the repository contents.

# Key Features

- Express-based server with route handlers for inventory, categories, replenishment, auth, and admin tasks.
- Scripts for syncing inventory, GTIN metadata, pushing names and categories to Square, and rebuilding master inventory.
- Integration with Google Firestore (via @google-cloud/firestore).
- Square SDK usage for interacting with Square APIs (square).
- Optional OpenAI usage (openai) and Algolia (algoliasearch) integrations referenced in dependencies.
- Auth support with Passport.js and Google OAuth (passport-google-oauth20).
- Image processing (sharp) and file uploads (multer).
- Several convenience bin scripts for deploying to Cloud Run and for running Cloud Run jobs.

# Tech Stack

- Runtime: Node.js (Docker base image node:22-alpine)
- Server: Express.js
- Authentication: passport, passport-local, passport-google-oauth20
- Database: Google Firestore (@google-cloud/firestore)
- Square integration: square SDK
- Utilities & integrations: axios, googleapis, algoliasearch, openai
- Image processing: sharp
- File upload: multer
- Dev/test: nodemon, jest, supertest
- Packaging: npm (scripts defined in package.json)

# Repository Layout

Top-level items (major folders/files and their roles inferred from names)

- app.js — Main Express application entry (routes mounted, middleware configured). Also exposes paths such as /healthz and /debug/env per routes listing.
- server.js — Likely responsible for starting the HTTP server (top-level file present).
- Dockerfile — Docker build configuration (Docker base image given as node:22-alpine).
- bin/ — Contains utility shell and node scripts for deploy and operational tasks:
  - deploy_square_inventory_sync.sh
  - generate_readme_ai.js
  - run_cloud_job.sh
  - scan_repo.js
  - sync_firestore_db.sh
- routes/ — Express route handlers (API and page routes). Many files provide endpoints used by front-end and API clients (see "API / Routes" section).
- scripts/ — Batch and one-off scripts to sync data, rebuild indices, migrate taxonomy, etc. Many npm script entries map to these files.
- lib/ — Helper libraries, notably:
  - lib/firestore.js — Firestore helper module
  - lib/loadEnv.js — Environment loader helper
- services/ — Likely contains business logic and service wrappers (names present but detailed contents not enumerated).
- auth/ — Authentication strategies and helpers (passport config likely lives here).
- middleware/ — Express middleware modules.
- public/ — Static assets served to UI.
- views/ — EJS views (ejs is a dependency).
- secrets/ — Directory to hold secrets or secret mount points (used in Cloud Run or local secrets handling).
- __tests__/ — Jest tests for units/integration.
- .github/ — GitHub workflows or actions.
- gpush.sh — Shell helper (purpose not explicit in JSON; placeholder).
- README.md — This file.
- LICENSE, .gitignore, .dockerignore — standard repo files.
- package.json / package-lock.json / jest.config.js — Node metadata and test config.

# Getting Started (local dev)

Prerequisites:
- Node.js compatible with node:22-alpine (Node 22).
- npm installed.
- If you need Firestore local emulator or Google credentials for tests/dev, follow Google Cloud SDK guidance (not included here).

Install:
- Install dependencies:
  npm install

Common local scripts:
- Start production-mode node server:
  npm run start
  (runs: node server.js)

- Start development server with nodemon and increased heap:
  npm run dev
  (runs: NODE_OPTIONS=--max-old-space-size=8192 nodemon app.js)

- Run tests:
  npm test
  npm run test:watch
  npm run test:ci

Run a specific sync script (examples):
- Sync inventory (one-off script):
  npm run sync:inventory
  (runs node scripts/syncInventory.js)

- Sync GTIN metadata from a sheet to Firestore:
  npm run sync:gtin-meta
  (runs node scripts/syncSheetToFirestore.js)

- Proper-case item names script:
  npm run proper:item-names
  (runs node scripts/properCaseItemNames.js)

Notes:
- Many scripts accept environment variables for behavior (see Configuration). If you use an .env file, ensure loadEnv/lib/loadEnv.js is configured to load it; otherwise set needed env vars in your shell.

# Configuration (Environment Variables)

Below is the list of environment keys present in the repository. The short descriptions reflect likely usage based strictly on the key names—do not treat these as exact values. Do not guess actual secrets or values; set them for your environment.

- ALLOWED_EMAILS — Comma-separated emails allowed to access the app (used in auth gating).
- APP_ENV — Application environment identifier (e.g., development/staging/production).
- BATCH_SIZE — Batch size for batched operations (scripts or API calls).
- CLEAN_DERIVED — Flag controlling cleaning of derived data.
- CLEAN_ONLY — Flag to run clean-only operations.
- CONFIRM_DELETE — Safety flag required to confirm delete operations.
- COST_SHEET_ID — Google Sheet ID for cost data.
- COST_SHEET_RANGE — Range within the sheet for cost data.
- DRY_RUN — When true, scripts should not persist changes.
- ENV_FILE — Path to an env file to load (may be used by lib/loadEnv.js).
- FIRESTORE_DATABASE_ID — Firestore Database ID to target multi-database setups.
- FIX — Flag to apply fixes vs. just report.
- GCLOUD_PROJECT — Google Cloud project id.
- GOOGLE_APPLICATION_CREDENTIALS — Path to service account JSON credentials for Google APIs.
- GOOGLE_CALLBACK_URL — OAuth callback URL for Google auth.
- GOOGLE_CLIENT_ID — OAuth client id for Google.
- GOOGLE_CLIENT_SECRET — OAuth client secret for Google.
- GOOGLE_CLOUD_PROJECT — Alternate/duplicate name for Google project id (both exist).
- GTIN — Specific GTIN for single-item scripts.
- GTINS — Comma-separated GTINs for batch processing.
- GTIN_SAMPLE_LIMIT — Limit sample GTINs for sampling scripts.
- IDEA_COUNT — Likely a count parameter for AI-generated ideas or suggestions.
- ITEM_LIMIT — Limit number of items processed.
- ITEM_NAME_COLLECTION — Firestore collection name for item names.
- JEST_WORKER_ID — Jest internal worker id (used by jest).
- K_SERVICE — Cloud Run service name environment variable present in Cloud Run.
- LIMIT — Generic limit parameter for scripts or APIs.
- LIMIT_GTINS — Limit for GTINs processed.
- LIMIT_PER_MERCHANT — Per-merchant limit.
- MERCHANT_ID — Single merchant id target.
- MERCHANT_IDS — Comma-separated merchant ids.
- MERCHANT_LABELS — Labels for merchants (comma-separated).
- NODE_ENV — Node environment variable.
- NORMALIZE_INVENTORY — Flag to normalize inventory values.
- ONLY_UNSYNCED — Flag to process only unsynced records.
- OPENAI_API_KEY — OpenAI API key (if using openai dependency).
- OPENAI_MODEL — OpenAI model identifier.
- PORT — HTTP port for server.
- READ_PAGE — Page token or read limit for paginated reads.
- REBUILD — Flag to trigger rebuilds.
- SAMPLE_LIMIT — Sample limit for scripts.
- SESSION_SECRET — Express session secret.
- SLEEP_MS — Sleep/delay in milliseconds for throttling scripts.
- SQUARE_ACCESS_TOKEN — Square API access token.
- SQUARE_APP_ID — Square application id.
- SQUARE_APP_SECRET — Square app secret.
- SQUARE_ENV — Square environment (e.g., sandbox/production).
- SQUARE_LOCATION_IDS — Comma-separated Square location ids.
- SQUARE_REDIRECT_URI — OAuth redirect URI for Square.
- SQUARE_REDIRECT_URI_DEV — Dev redirect URI for Square.
- SQUARE_REDIRECT_URI_PROD — Prod redirect URI for Square.
- TARGET_GTIN — Target GTIN for certain operations.
- TARGET_MERCHANT_ID — Target merchant id.
- USE_FIRESTORE_CACHE — Flag to enable Firestore response caching.
- USE_SQUARE_API — Flag to toggle Square API calls vs. dry logic.
- WINDOW_DAYS — Window in days for lookback-based scripts.
- WRITE_BATCH — Number of writes per Firestore batch operation.

If a configuration key is unclear for your environment, create a local .env and set placeholders, and then securely inject production secrets into Cloud Run (see Cloud Run Jobs Notes & Security Notes).

# Common Workflows

Build and run locally:
- Install deps and run dev server:
  npm install
  npm run dev

Run production server locally:
- Start server.js:
  npm run start
  NODE_ENV=production PORT=8080 npm run start

Run tests:
- Run Jest once:
  npm test
- Run Jest in watch mode:
  npm run test:watch
- CI-friendly jest:
  npm run test:ci

Run scripts:
- Run inventory sync (example):
  npm run sync:inventory
- Rebuild master inventory:
  npm run rebuild:master-inventory
- Sync missing items to Square:
  npm run sync:missing-items-to-square

Docker build and run (based on Dockerfile and Docker metadata):
- Build image (tag example):
  docker build -t gcr.io/<PROJECT_ID>/square-inventory-sync:latest .
- Run container:
  docker run -e PORT=8080 -p 8080:8080 gcr.io/<PROJECT_ID>/square-inventory-sync:latest

Deploy to Cloud Run (examples inspired by bin/deploy_square_inventory_sync.sh):
- Build and push:
  gcloud builds submit --tag "${IMAGE}"
- Deploy:
  gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE}" \
    --region="${REGION}" \
    --platform=managed
- Update traffic:
  gcloud run services update-traffic "${SERVICE_NAME}" --to-latest

Run Cloud Run Job (from bin/run_cloud_job.sh pattern):
- Example sequence (replace placeholders):
  gcloud config set project "$PROJECT_ID"
  gcloud builds submit --tag "$IMAGE"
  gcloud run jobs update "$JOB" --image "$IMAGE" --region "$REGION"
  gcloud run jobs execute "$JOB" --region "$REGION"

Firestore sync utilities:
- There are bin scripts for exporting/importing Firestore; example flow based on bin/sync_firestore_db.sh:
  gcloud config set project "$PROJECT"
  gcloud firestore export "$EXPORT_PATH" --database="$SOURCE_DB"
  gcloud firestore databases delete --database="$TARGET_DB" --quiet
  gcloud firestore databases create --database="$TARGET_DB" --location="$SRC_LOCATION"
  gcloud firestore import "$EXPORT_PATH" --database="$TARGET_DB"

# API / Routes

Below is a grouping of routes by file with the HTTP method and path as found in the repository routing list.

app.js
- GET /healthz
- GET /
- GET /debug/env

routes/apiUpdates.js
- POST /api/update-price
- POST /api/update-item-name

routes/auth.js
- GET /login
- POST /login
- GET /auth/google
- GET /auth/google/callback
- POST /logout

routes/categoriesList.js
- GET /api/categories

routes/categoriesRename.js
- POST /api/categories/rename

routes/categoryActions.js
- POST /api/categories/copy
- POST /api/categories/delete-all

routes/categoryMatrix.js
- GET /api/category-matrix

routes/categorySync.js
- POST /api/categories/sync-from-square

routes/copyItemInfo.js
- POST /api/copy-item-info

routes/deleteGtin.js
- POST /delete-item

routes/gtinDuplicates.js
- GET /api/gtin-duplicates

routes/gtinInventoryMatrix.js
- GET /api/duplicates-inventory-matrix

routes/gtinInventoryMatrixConsolidated.js
- GET /api/gtin-inventory-matrix

routes/gtinMatrix.js
- GET /api/gtin-matrix

routes/gtinMeta.js
- GET /api/gtin-meta
- PUT /api/gtin-meta/:gtin

routes/indexPages.js
- GET /
- GET /reorder
- GET /dashboard
- GET /dashboard/:merchantId
- GET /dashboard-gtin
- GET /duplicates-gtin
- GET /dashboard-vendor-costs
- GET /inventory-integrity
- GET /reports
- GET /categories
- GET /category-matrix

routes/inventory.js
- GET /api/inventory

routes/inventoryIntegrityRoutes.js
- GET /inventory/negatives
- POST /inventory/fix
- GET /inventory/row

routes/itemImages.js
- POST /api/update-item-image

routes/itemsSetCategoryId.js
- POST /api/items/set-category-id

routes/itemsUpdateFields.js
- POST /api/items/update-fields

routes/reorderRoutes.js
- GET /api/reorder

routes/replenishment.js
- GET /api/replenishment

routes/replenishmentAiApi.js
- POST /api/replenishment-ai/plan
- POST /api/replenishment-ai/audit

routes/replenishmentAiPage.js
- GET /replenishment-ai/:merchantId?

routes/squareCategories.js
- GET /api/square-categories

routes/squareOAuth.js
- GET /connect-square
- GET /square/oauth/callback

routes/tasks.js
- POST /tasks/sync-inventory
- GET /tasks/full-nightly-sync

Note: Some files in routes/indexPages.js expose "/" twice (app.js and indexPages.js both list GET /). Verify routing in code if collisions arise.

# Cloud Run Jobs Notes

This repository includes scripts and bin helpers for Cloud Run jobs. Key points:

How to run a Cloud Run job (pattern derived from bin/run_cloud_job.sh):
- Build the image:
  gcloud builds submit --tag "$IMAGE"
- Update the job definition:
  gcloud run jobs update "$JOB" --image "$IMAGE" --region "$REGION"
- Execute the job:
  gcloud run jobs execute "$JOB" --region "$REGION"

Secrets and credential mounting:
- The project references GOOGLE_APPLICATION_CREDENTIALS and a secrets directory. In Cloud Run, service account keys should not be baked into images. Instead:
  - Use Workload Identity or mount secrets via Secret Manager to environment variables or files.
  - If your job expects GOOGLE_APPLICATION_CREDENTIALS to point to a JSON file path, mount the secret to that path in the Cloud Run job configuration.

Common failure modes when running Cloud Run jobs:
- Missing/incorrect GOOGLE_APPLICATION_CREDENTIALS:
  - Symptom: Firestore or Google API permission errors.
  - Fix: Ensure proper service account credentials are mounted or use Workload Identity.
- Wrong GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT:
  - Symptom: gcloud commands or Firestore access failing due to wrong project.
  - Fix: Set GCLOUD_PROJECT and/or GOOGLE_CLOUD_PROJECT to the intended project id.
- SQUARE_ACCESS_TOKEN / SQUARE_APP_SECRET not provided:
  - Symptom: Square API calls fail or return 401.
  - Fix: Provide Square credentials via Secret Manager and map them to env vars.
- JOB definition mismatch:
  - Symptom: gcloud run jobs execute fails because job was not updated with the correct image.
  - Fix: Run the update job command before execute as shown above.

# Troubleshooting

Below are concrete problems you may encounter and steps to fix them based on repository structure.

1) App crashes on startup due to missing SESSION_SECRET
- Symptom: App throws an error when requiring session middleware.
- Fix: Set SESSION_SECRET in your environment (export SESSION_SECRET="your-secret") or provide via ENV_FILE loaded by lib/loadEnv.js.

2) Firestore permission or auth errors
- Symptom: SDK throws permission denied or auth errors when connecting to Firestore.
- Fix: Ensure GOOGLE_APPLICATION_CREDENTIALS is set to a valid service account JSON path accessible to the container or enable Workload Identity on Cloud Run. Confirm GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT match your Firestore project.

3) Google OAuth login failing / callback mismatch
- Symptom: Google OAuth returns "redirect_uri_mismatch".
- Fix: Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL. Ensure the callback URL configured in Google Cloud Console matches the value in your env.

4) Square API 401/403 responses
- Symptom: Requests to Square APIs fail with unauthorized.
- Fix: Set SQUARE_ACCESS_TOKEN, SQUARE_APP_ID, and SQUARE_APP_SECRET appropriately. Ensure SQUARE_ENV matches the environment (sandbox vs production) and SQUARE_REDIRECT_URI values match OAuth app configuration.

5) Sync scripts run but make no changes (dry-run behavior)
- Symptom: Scripts report operations but do not persist.
- Fix: Set DRY_RUN=false or unset it. Many scripts support DRY_RUN; check command output or set FIX to enable applying fixes.

6) Jest tests failing due to JEST_WORKER_ID or port in use
- Symptom: Tests fail when run in CI or locally, or nodemon consumes high memory.
- Fix: Run tests in band using the npm script designed for CI:
  npm run test:ci
  or
  JEST_WORKER_ID=1 npm test

7) Docker image small or Node crash due to memory limits
- Symptom: Node out-of-memory errors during dev or build.
- Fix: Dev script already sets NODE_OPTIONS=--max-old-space-size=8192 in npm run dev. For production images, consider raising memory limits in Cloud Run or container runtime.

8) Routes conflict or duplicate "/" route
- Symptom: Multiple route handlers list GET /.
- Fix: Inspect app.js and routes/indexPages.js to see which handler is mounted first. Adjust route mounting order if necessary.

9) Cloud Run job fails with "database not found" when syncing Firestore
- Symptom: bin/sync_firestore_db.sh style flows attempt to import/export databases by id and fail.
- Fix: Confirm FIRESTORE_DATABASE_ID and related variables (SOURCE_DB, TARGET_DB) are set. Follow commands sequence: export, delete/create target DB, import.

10) Environment variables not loaded in local dev
- Symptom: Env variables present in .env but not applied.
- Fix: Ensure lib/loadEnv.js is invoked at app startup or export ENV_FILE pointing to your .env. Alternatively export variables in your shell before running npm scripts.

# Security Notes

- Secrets handling: Do not hardcode secrets in the repository. Use Secret Manager or Cloud Run secret mounts for production SQUARE_* and GOOGLE_* credentials. The repository contains a secrets/ directory; treat it carefully and do not commit production secrets.
- GOOGLE_APPLICATION_CREDENTIALS: If the app relies on a file path for Google credentials, mount the service account JSON in the container and set GOOGLE_APPLICATION_CREDENTIALS to the file path. Prefer Workload Identity for Cloud Run to eliminate the need for service account key files.
- Session secrets: SESSION_SECRET must be strong and never stored in version control.
- .env files and semicolons: When creating .env entries, if a value contains semicolons (;) or other special characters, wrap the value in quotes to ensure parsers (dotenv or custom loaders) interpret them correctly:
  Example .env:
  SESSION_SECRET="abc;123;secret"
  GOOGLE_CALLBACK_URL="https://example.com/auth/google/callback"
- Principle of least privilege: Grant service accounts only the permissions required (Firestore read/write, secret access, etc.).

# Contributing / Maintenance

- Tests: Run unit/integration tests with Jest:
  npm test
  npm run test:ci
  For iterative development:
  npm run test:watch

- Regenerate README / automation:
  The bin directory includes generate_readme_ai.js which appears to be a script present in the repository. If you maintain automated README generation, review that file to understand its inputs and usage. (I cannot assume behavior beyond the file's presence.)

- Deploy scripts:
  Use the shell scripts in bin/ to standardize deployment and job execution:
  - bin/deploy_square_inventory_sync.sh — contains gcloud build and run deploy commands.
  - bin/run_cloud_job.sh — contains build and job execution flow.
  - bin/sync_firestore_db.sh — firestorer export/import flow.

- Linting: No linter is present in dependencies list. If you introduce linting, add configuration and a package.json script (e.g., eslint) to standardize code quality.

- Adding tests: Put tests under __tests__ using jest. Existing package.json has test scripts configured.

- Scripts maintenance: Many operational scripts live in scripts/. Keep these idempotent and ensure DRY_RUN/CONFIRM_DELETE flags are respected to avoid accidental destructive operations.

If something in this README is ambiguous based on repository contents (for example, exact behavior of generate_readme_ai.js or the content/structure of lib/loadEnv.js), inspect those files directly to confirm required arguments and side effects.

---

If you need runnable examples tailored to a specific environment (Cloud Run region, project id, image name, or a sample .env file populated with placeholders), provide the target environment variables and I can produce a ready-to-run command set or sample .env with placeholders.