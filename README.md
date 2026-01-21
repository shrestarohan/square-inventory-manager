# Project Overview

square-inventory-sync is a Node.js service designed to synchronize and manage inventory data across Square and Firestore (and related systems). It provides a web UI and a set of API endpoints and scripts for daily syncs, GTIN handling, inventory reconciliation, category syncs, image copying, and other inventory operations. The repository includes Cloud Run deployment helpers and a set of CLI/bin scripts to automate builds and job execution.

This README documents the repository layout, the main workflows (local development, build, deploy, and running scheduled jobs), API surface (routes), environment configuration, troubleshooting tips, and contributor guidance.

---

## Key Features

- Inventory synchronization scripts and scheduled job entry points for:
  - GTIN meta management and matrix builds
  - Inventory syncs and nightly full syncs
  - Replenishment recommendation workflows (including AI endpoints)
  - Category and item syncing with Square
- Web UI routes for dashboards, reports, and category management
- Express-based API for updates (prices, item names, images, categories, and more)
- Integration with Square API, Google APIs (Firestore, Drive/Sheets), OpenAI, and Algolia
- Tools and scripts for copying images across merchants and rebuilding consolidated master inventory
- Cloud Run / Cloud Build deployment helper scripts and job-run scripts

---

## Tech Stack

- Node.js (base image: node:22-alpine)
- Express for HTTP server and routing
- EJS views for server-rendered UI
- Firestore (Google Cloud) via @google-cloud/firestore
- Square SDK (square)
- Google APIs (googleapis)
- OpenAI SDK (openai)
- Algolia (algoliasearch)
- Other utilities: axios, bcryptjs, multer, sharp, passport (Google + local), express-session
- Testing: Jest and Supertest
- Dev tooling: nodemon, cross-env

---

## Repository Layout

Top-level entries (major folders and key files):

- __tests__/ — Test suite for the project (Jest)
- .github/ — GitHub Actions / workflows (not detailed here)
- auth/ — Authentication logic (passport strategies, session handling)
- bin/ — Deployment and automation shell scripts:
  - deploy_square_inventory_sync.sh
  - generate_readme_ai.js
  - git_push_current.sh
  - run_cloud_job.sh
  - scan_repo.js
  - sync_firestore_db.sh
- lib/ — Shared libraries and helpers (notable files include lib/firestore.js and lib/loadEnv.js)
- middleware/ — Express middleware
- public/ — Static assets served by the app
- routes/ — Express route handlers (API and page routes)
- scripts/ — Long-running/one-off scripts for syncing and maintenance:
  - syncInventory.js, rebuildMasterInventory.js, syncSheetToFirestore.js, etc.
- secrets/ — Local secret files or placeholders (see Security Notes)
- services/ — Service abstractions (Square, Firestore, etc.)
- views/ — EJS templates for server-rendered pages
- app.js — main Express application (registers routes)
- server.js — server startup script (used by package.json start)
- Dockerfile — Docker build instructions (base image: node:22-alpine)
- package.json / package-lock.json — npm scripts and dependencies
- README.md — this document
- repo.summary.json, gpush.sh, jest.config.js, LICENSE — supporting files

---

## Getting Started (local dev)

Prerequisites:
- Node.js (image based on node:22-alpine — use Node 22.x locally for parity)
- npm or yarn
- Google Cloud SDK & gcloud (if interacting with Firestore or deploying)
- Credentials for external services (Square, Google Cloud, OpenAI, Algolia) provided via environment variables or secrets files (see Configuration)

Install and run locally:

1. Install dependencies
   - npm ci
2. Start in development mode with file reloads and increased memory
   - npm run dev
   - This runs: NODE_OPTIONS=--max-old-space-size=8192 nodemon app.js
3. To run the production server locally:
   - npm start
   - This runs: node server.js

Run a specific sync script locally (examples):
- npm run sync:inventory
- npm run sync:gtin-meta
- npm run rebuild:master-inventory
- npm run sync:item-names-to-square

Tests:
- npm test
- npm run test:watch
- npm run test:ci

Practical example: run the inventory sync and log output to file
- npm run sync:inventory --silent 2>&1 | tee sync-inventory.log

Note: many scripts accept environment variables to scope work (see Configuration).

---

## Configuration (Environment Variables)

Below is the list of environment variables found in the repository and what they likely control (based only on names). Do not assume actual values — set these in your environment, .env files, or secret manager:

- ALLOWED_EMAILS — comma-separated list of emails allowed to log in (auth gating)
- APP_ENV — application environment name (e.g., development, production)
- BATCH_SIZE — batch size used for batched operations (exports, writes)
- CLEAN_DERIVED — flag to control cleaning of derived data
- CLEAN_ONLY — flag for running only cleanup actions
- CONFIRM_DELETE — safety flag to confirm destructive operations
- COST_SHEET_ID — Google Sheets ID for cost data
- COST_SHEET_RANGE — Sheet range to read cost data from
- DRY_RUN — flag to run scripts without making changes
- ENV_FILE — path to environment file
- ENV_PATH — base path for environment files
- FIRESTORE_DATABASE_ID — Firestore database identifier
- FIX — general flag for applying fixes
- GCLOUD_PROJECT — Google Cloud project id
- GOOGLE_APPLICATION_CREDENTIALS — path to Google service account JSON file
- GOOGLE_CALLBACK_URL — OAuth callback URL for Google auth
- GOOGLE_CLIENT_ID — Google OAuth client ID
- GOOGLE_CLIENT_SECRET — Google OAuth client secret
- GOOGLE_CLOUD_PROJECT — another Google project variable
- GTIN — single GTIN value used by scripts
- GTINS — list of GTINs
- GTIN_SAMPLE_LIMIT — limit when sampling GTINs
- IDEA_COUNT — number of ideas or suggestions (used by AI features)
- ITEM_LIMIT — maximum items to process in a job
- ITEM_NAME_COLLECTION — Firestore collection name for item names
- JEST_WORKER_ID — Jest internal worker id (for tests)
- K_SERVICE — Cloud Run service name (in Cloud Run env)
- LIMIT — generic limit for script operations
- LIMIT_GTINS — limit for GTIN operations
- LIMIT_PER_MERCHANT — per-merchant processing limit
- MERCHANT_ID — merchant scope for operations
- MERCHANT_IDS — list of merchant ids
- MERCHANT_LABELS — labels/names for merchants
- NODE_ENV — node environment (development/production)
- NORMALIZE_INVENTORY — flag to normalize inventory data during sync
- ONLY_UNSYNCED — process only unsynced records
- OPENAI_API_KEY — API key for OpenAI integration
- OPENAI_MODEL — model name used for AI calls
- PORT — HTTP server port
- READ_PAGE — pagination/read page indicator for scripts
- REBUILD — flag to trigger a rebuild path
- SAMPLE_LIMIT — sampling limit
- SESSION_SECRET — secret used by express-session
- SLEEP_MS — delay between batches or API calls
- SQUARE_ACCESS_TOKEN — Square API access token
- SQUARE_APP_ID — Square application id
- SQUARE_APP_SECRET — Square application secret
- SQUARE_ENV — Square environment (production/sandbox)
- SQUARE_LOCATION_IDS — comma-separated Square location ids
- SQUARE_REDIRECT_URI — OAuth redirect URI for Square
- SQUARE_REDIRECT_URI_DEV — dev redirect URI for Square
- SQUARE_REDIRECT_URI_PROD — prod redirect URI for Square
- TARGET_GTIN — GTIN target for specific operations
- TARGET_MERCHANT_ID — merchant id target for operations
- USE_FIRESTORE_CACHE — toggle use of a Firestore cache
- USE_SQUARE_API — toggle calls to Square API
- WINDOW_DAYS — number of days window for time-based reports
- WRITE_BATCH — batch size for writes

If a variable's intended format or allowed values are unclear, use placeholders in your .env (for example: SQUARE_ACCESS_TOKEN="YOUR_SQUARE_TOKEN_HERE").

---

## Common Workflows

Build and Docker
- Build a container (using variables defined in bin scripts):
  - gcloud builds submit --tag "${IMAGE}"
  - Replace ${IMAGE} with a proper image tag (e.g., gcr.io/your-project/square-inventory-sync:latest)
- Dockerfile uses base node:22-alpine (see Dockerfile). If you need to build locally:
  - docker build -t square-inventory-sync:local .
  - docker run -p 3000:3000 --env-file .env square-inventory-sync:local

Deploy to Cloud Run
- The repository provides a deployment script: bin/deploy_square_inventory_sync.sh
- Typical gcloud commands used (from bin/deploy_square_inventory_sync.sh):
  - gcloud builds submit --tag "${IMAGE}"
  - gcloud run deploy "${SERVICE_NAME}" \
  - gcloud run services update-traffic "${SERVICE_NAME}" \
- Replace placeholders:
  - ${IMAGE} — container image path
  - ${SERVICE_NAME} — Cloud Run service name

Run Cloud Run Jobs
- Use bin/run_cloud_job.sh which issues:
  - gcloud config set project "$PROJECT_ID"
  - gcloud builds submit --tag "$IMAGE"
  - gcloud run jobs update "$JOB" --region "$REGION"
  - gcloud run jobs execute "$JOB" --region "$REGION"
- Replace $JOB, $IMAGE, $PROJECT_ID and $REGION with your values.

Firestore sync or copy
- bin/sync_firestore_db.sh contains gcloud firestore export/import and database create/delete steps. Use with caution — these are destructive when targeting databases.

Run scripts and tasks (examples)
- Run a task endpoint locally (sync-inventory):
  - POST /tasks/sync-inventory (route exists in routes/tasks.js)
- Run nightly/full sync manually:
  - node scripts/fullNightlySync.js
  - or via npm script if mapped: npm run <script-name> (see package.json scripts)

Common npm scripts
- npm run dev — start app in dev mode with nodemon
- npm start — start server with node server.js
- npm run sync:inventory — run inventory sync script
- npm run sync:gtin-meta — sync GTIN metadata to Firestore
- npm run proper:item-names — run properCaseItemNames.js
- npm test — run Jest test suite

---

## API / Routes (grouped by file)

Below are the registered routes (method + path) grouped by file. Use these endpoints to interact with the HTTP API.

- app.js
  - GET /healthz
  - GET /
  - GET /debug/env

- routes/apiUpdates.js
  - POST /api/update-price
  - POST /api/update-item-name

- routes/auth.js
  - GET /login
  - POST /login
  - GET /auth/google
  - GET /auth/google/callback
  - POST /logout

- routes/categoriesList.js
  - GET /api/categories

- routes/categoriesRename.js
  - POST /api/categories/rename

- routes/categoryActions.js
  - POST /api/categories/copy
  - POST /api/categories/delete-all

- routes/categoryMatrix.js
  - GET /api/category-matrix

- routes/categorySync.js
  - POST /api/categories/sync-from-square

- routes/copyItemInfo.js
  - POST /api/copy-item-info

- routes/deleteGtin.js
  - POST /delete-item

- routes/gtinDuplicates.js
  - GET /api/gtin-duplicates

- routes/gtinInventoryMatrix.js
  - GET /api/duplicates-inventory-matrix

- routes/gtinInventoryMatrixConsolidated.js
  - GET /api/gtin-inventory-matrix

- routes/gtinMatrix.js
  - GET /api/gtin-matrix

- routes/gtinMeta.js
  - GET /api/gtin-meta
  - PUT /api/gtin-meta/:gtin

- routes/indexPages.js
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

- routes/inventory.js
  - GET /api/inventory

- routes/inventoryIntegrityRoutes.js
  - GET /inventory/negatives
  - POST /inventory/fix
  - GET /inventory/row

- routes/itemImages.js
  - POST /api/update-item-image

- routes/itemsSetCategoryId.js
  - POST /api/items/set-category-id

- routes/itemsUpdateFields.js
  - POST /api/items/update-fields

- routes/reorderRoutes.js
  - GET /api/reorder

- routes/replenishment.js
  - GET /api/replenishment

- routes/replenishmentAiApi.js
  - POST /api/replenishment-ai/plan
  - POST /api/replenishment-ai/audit

- routes/replenishmentAiPage.js
  - GET /replenishment-ai/:merchantId?

- routes/squareCategories.js
  - GET /api/square-categories

- routes/squareOAuth.js
  - GET /connect-square
  - GET /square/oauth/callback

- routes/tasks.js
  - POST /tasks/sync-inventory
  - GET /tasks/full-nightly-sync

Example curl (update price):
- curl -X POST -H "Content-Type: application/json" -d '{"itemId":"...","price":1234}' http://localhost:PORT/api/update-price

Replace PORT with the configured PORT env var.

---

## Cloud Run Jobs Notes

How to run:
- Use bin/run_cloud_job.sh to build the image, update the job and execute it. The script pattern:
  - gcloud config set project "$PROJECT_ID"
  - gcloud builds submit --tag "$IMAGE"
  - gcloud run jobs update "$JOB" --region "$REGION" ...
  - gcloud run jobs execute "$JOB" --region "$REGION"

Placeholders you need to supply:
- $PROJECT_ID — Google Cloud project
- $IMAGE — container image (eg. gcr.io/project/image:tag)
- $JOB — Cloud Run job name
- $REGION — Cloud region

Secrets and credentials:
- The repository includes a secrets/ directory and uses GOOGLE_APPLICATION_CREDENTIALS and GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT env vars. Common patterns:
  - Set GOOGLE_APPLICATION_CREDENTIALS to point to a service account JSON file in the container or mounted via secret/volume.
  - Configure Cloud Run service or job to inject secrets as environment variables or as mounted files. Check lib/loadEnv.js and lib/firestore.js (notable files) to see how credentials are expected to be loaded.

Common Cloud Run Job failure modes (high-level; see Troubleshooting for concrete fixes):
- Missing GOOGLE_APPLICATION_CREDENTIALS or incorrect path -> Firestore auth fails.
- Incorrect PROJECT_ID or region -> gcloud run job update/execute fail.
- Container exits immediately -> missing CMD/ENTRYPOINT or start script not configured.
- API rate limits or auth failures for Square/OpenAI.

---

## Troubleshooting

Below are concrete, repository-grounded issues and recommended fixes:

1. Problem: Server does not start in production container.
   - Fix: Ensure package.json start script exists ("node server.js") and Dockerfile sets a CMD/ENTRYPOINT that runs npm start or node server.js. Confirm PORT env var is provided to Cloud Run.

2. Problem: Firestore permission/authentication errors.
   - Fix: Set GOOGLE_APPLICATION_CREDENTIALS to a valid service account JSON and ensure GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT match your Google project. Verify the service account has Firestore permissions.

3. Problem: Square API calls return 401/403.
   - Fix: Verify SQUARE_ACCESS_TOKEN, SQUARE_APP_ID, SQUARE_APP_SECRET and SQUARE_ENV are set correctly. Ensure USE_SQUARE_API is enabled if required.

4. Problem: Scripts run out of memory when processing large batches.
   - Fix: The dev script sets NODE_OPTIONS=--max-old-space-size=8192. For production containers, increase memory limits or tune BATCH_SIZE/WRITE_BATCH env vars.

5. Problem: Cloud Run job update/execute failing with project/region errors.
   - Fix: Provide correct PROJECT_ID, REGION, IMAGE, and JOB variables when running bin/run_cloud_job.sh. Confirm gcloud is authenticated and configured.

6. Problem: Changes not visible in Square after sync scripts run.
   - Fix: Confirm USE_SQUARE_API is true and scripts are not running with DRY_RUN. Check logs for errors and confirm SQUARE_LOCATION_IDS / merchant scoping variables.

7. Problem: Tests fail sporadically in CI due to Jest worker conflicts.
   - Fix: Use npm run test:ci to run jest --ci --runInBand or ensure JEST_WORKER_ID is set appropriately. Running tests with --runInBand reduces parallelism-related flakiness.

8. Problem: Environment variables with semicolons or special characters break parsing.
   - Fix: Quote values in your .env or export commands. See Security Notes below for .env semicolon handling.

9. Problem: Google Sheets / Drive integrations failing to read ranges.
   - Fix: Ensure COST_SHEET_ID and COST_SHEET_RANGE are set correctly and the Google service account has permissions to access the sheet.

10. Problem: Container image builds fail in Cloud Build due to missing build context or incorrect image tag.
    - Fix: Ensure the build command gcloud builds submit --tag "$IMAGE" is run from the repository root and $IMAGE is a fully qualified image path (e.g., gcr.io/<project>/<image>:tag).

11. Problem: Missing or misnamed secrets directory causes startup to fail.
    - Fix: Verify the secrets/ directory contents and ensure lib/loadEnv.js or startup code is pointed at ENV_FILE/ENV_PATH to load secrets.

---

## Security Notes

- Secrets handling
  - The repo expects service credentials and API keys to be provided through environment variables (e.g., GOOGLE_APPLICATION_CREDENTIALS, SQUARE_ACCESS_TOKEN, OPENAI_API_KEY) or via a secrets/ directory. In production, prefer secret manager integrations (Cloud Secret Manager) or Cloud Run secret mounts rather than committing files to the repo.
  - Do not commit service account JSON files or plain text secrets into version control.

- .env quoting / semicolons
  - When using .env files or shell exports, quote values that contain semicolons, spaces, or special characters. For example:
    - SQUARE_ACCESS_TOKEN="sq0atp-abc;def;gh"
  - Unquoted semicolons can be interpreted by shells as command separators, or by parsers as delimiters — this causes misconfigured env values.

- Session and auth secrets
  - SESSION_SECRET must be set to a secure, random value in production to protect session integrity.

---

## Contributing / Maintenance

Regenerating documentation
- The repo includes bin/generate_readme_ai.js which appears intended to generate or assist README generation. Use it if you need to re-generate this document (inspect the script before running).

Testing
- Run tests locally:
  - npm test
  - For watch mode: npm run test:watch
  - For CI: npm run test:ci

Code formatting and linting
- No linter is listed in package.json devDependencies. If you add formatting tools, document them and add npm scripts.

Scripts and code maintenance
- Scripts in scripts/ are used for data migrations, syncs, and cleanups. When modifying scripts:
  - Add dry-run options (DRY_RUN) when possible
  - Use BATCH_SIZE and WRITE_BATCH environment variables to control throughput
  - Add logging and idempotency checks for safer reruns

Pull requests
- Follow existing project conventions for tests and commit messages. Ensure new features add tests under __tests__/ when appropriate.

Maintenance scripts / Automation
- bin/deploy_square_inventory_sync.sh — deployment helper (wraps gcloud builds + run deploy commands)
- bin/sync_firestore_db.sh — helper to export/import Firestore databases (use carefully; it contains database delete/create steps)
- bin/run_cloud_job.sh — wrapper to build and run Cloud Run jobs

---

If anything in your environment or setup is unclear (for example, the exact runtime flags expected by specific scripts, or the structure expected within secrets/), inspect the notable files lib/loadEnv.js and lib/firestore.js to determine how environment variables and credentials are loaded, or ask the repository owner to provide example .env files and secret configuration.