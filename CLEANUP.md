# Cleanup Audit
Generated: 2026-01-05T07:13:15.512Z

## Summary
- Total files: 109
- JS files: 78
- Shell scripts: 4
- Docker: FROM node:22-alpine, WORKDIR /app

## High Priority Checks
- .gitignore present: ✅
- .dockerignore present: ✅

## Path Drift (WORKDIR /app vs /usr/src/app)
- Dockerfile: WORKDIR /app
- bin/cleanup_audit.js: /usr/src/app, WORKDIR /usr/src/app, WORKDIR /app, /app
- bin/run_cloud_job.sh: /usr/src/app, /app

## Env Vars
### Env files found
- secrets/.env
- secrets/.env.deploy

### Env vars referenced in code but missing from env files
- BATCH_SIZE
- CLEAN_DERIVED
- CLEAN_ONLY
- CONFIRM_DELETE
- DRY_RUN
- ENV_FILE
- ENV_PATH
- FIX
- GCLOUD_PROJECT
- GOOGLE_APPLICATION_CREDENTIALS
- GTIN
- GTINS
- GTIN_SAMPLE_LIMIT
- ITEM_LIMIT
- ITEM_NAME_COLLECTION
- JEST_WORKER_ID
- K_SERVICE
- LIMIT
- LIMIT_GTINS
- LIMIT_PER_MERCHANT
- MERCHANT_ID
- MERCHANT_IDS
- MERCHANT_LABELS
- NODE_ENV
- NORMALIZE_INVENTORY
- ONLY_UNSYNCED
- PORT
- READ_PAGE
- REBUILD
- SAMPLE_LIMIT
- SLEEP_MS
- SQUARE_APP_ID
- SQUARE_APP_SECRET
- SQUARE_LOCATION_IDS
- SQUARE_REDIRECT_URI_DEV
- SQUARE_REDIRECT_URI_PROD
- TARGET_GTIN
- TARGET_MERCHANT_ID
- WRITE_BATCH

### Env vars present in env files but not referenced in code
- CRON_SECRET
- SLACK_WEBHOOK_URL

## gcloud usage in shell scripts
### bin/deploy_square_inventory_sync.sh
- L61: `gcloud builds submit --tag "${IMAGE}"`
- L64: `gcloud run deploy "${SERVICE_NAME}" \`
- L111: `gcloud run services update-traffic "${SERVICE_NAME}" \`
### bin/run_cloud_job.sh
- L92: `gcloud config set project "$PROJECT_ID" >/dev/null`
- L93: `gcloud builds submit --tag "$IMAGE"`
- L143: `gcloud config set project "$PROJECT_ID" >/dev/null`
- L161: `gcloud run jobs update "$JOB" \`
- L172: `gcloud config set project "$PROJECT_ID" >/dev/null`
- L201: `gcloud run jobs update "$JOB" \`
- L208: `gcloud run jobs execute "$JOB" --region "$REGION"`
### bin/sync_firestore_db.sh
- L58: `gcloud config set project "$PROJECT" >/dev/null`
- L59: `gcloud firestore databases list`
- L82: `gcloud config set project "$PROJECT" >/dev/null`
- L148: `gcloud firestore export "$EXPORT_PATH" --database="$SOURCE_DB"`
- L155: `gcloud firestore databases delete --database="$TARGET_DB" --quiet`
- L162: `gcloud firestore databases create --database="$TARGET_DB" --location="$SRC_LOCATION"`
- L170: `gcloud firestore import "$EXPORT_PATH" --database="$TARGET_DB"`

## Potential Secrets Detected (patterns only, no values shown)
- bin/deploy_square_inventory_sync.sh: Generic *_SECRET assignment
- bin/run_cloud_job.sh: Generic *_SECRET assignment
- routes/squareOAuth.js: Generic *_SECRET assignment

## Likely Dead JS Files (best-effort)
- __tests__/gtinMatrixRoute.test.js
- __tests__/health.test.js
- __tests__/jest.setup.js
- auth/passportConfig.js
- jest.config.js

## Top-level files
- .dockerignore
- .gitignore
- Dockerfile
- LICENSE
- README.md
- app.js
- jest.config.js
- package-lock.json
- package.json
- repo.cleanup.json
- repo.summary.json
- server.js

## Next Steps
1. Review Path Drift list and standardize on one WORKDIR/path scheme (your Dockerfile currently decides).
2. Review Likely Dead JS list and confirm before deletion.
3. Ensure secrets are in Secret Manager and env files are gitignored.
4. Consolidate duplicate shell scripts (gcloud commands).
