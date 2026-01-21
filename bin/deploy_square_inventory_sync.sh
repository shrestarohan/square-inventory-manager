#!/usr/bin/env bash

# /bin/deploy-square-inventory-sync.sh
# Usage:
#   ./bin/deploy-square-inventory-sync.sh YOUR_PROJECT_ID [REGION]
#
# Example:
#   ./bin/deploy-square-inventory-sync.sh square-inventory-480509 us-central1

set -e

PROJECT_ID="$1"
REGION="${2:-us-central1}"   # default region is us-central1
SERVICE_NAME="square-inventory-sync"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
ENV_FILE="secrets/.env.deploy"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: PROJECT_ID is required."
  echo "Usage: $0 YOUR_PROJECT_ID [REGION]"
  exit 1
fi

# Load env vars from .env.deploy into the current shell
if [ -f "$ENV_FILE" ]; then
  echo "Loading env vars from ${ENV_FILE}"
  # Ignore comments and blank lines, export KEY=VALUE pairs
  # (works as long as values have no spaces)
  # shellcheck disable=SC2046
  export $(grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -v '^[[:space:]]*$' | xargs)
else
  echo "Warning: ${ENV_FILE} not found. Continuing without loading env vars."
fi

# Build a single --set-env-vars string so gcloud parses it cleanly
ENV_VARS="\
APP_ENV=${APP_ENV},\
GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},\
FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID},\
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},\
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET},\
GOOGLE_CALLBACK_URL=${GOOGLE_CALLBACK_URL},\
SESSION_SECRET=${SESSION_SECRET},\
ALLOWED_EMAILS=${ALLOWED_EMAILS},\
COST_SHEET_ID=${COST_SHEET_ID},\
COST_SHEET_RANGE=${COST_SHEET_RANGE},\
CRON_SECRET=${CRON_SECRET},\
OPENAI_API_KEY=${OPENAI_API_KEY},\
OPENAI_MODEL=${OPENAI_MODEL},\
SQUARE_ACCESS_TOKEN=${SQUARE_ACCESS_TOKEN},\
SQUARE_APP_ID=${SQUARE_APP_ID},\
SQUARE_APP_SECRET=${SQUARE_APP_SECRET},\
SQUARE_REDIRECT_URI=${SQUARE_REDIRECT_URI},\
SQUARE_ENV=${SQUARE_ENV},\
SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL},\
WINDOW_DAYS=${WINDOW_DAYS},\
IDEA_COUNT=${IDEA_COUNT},\
USE_SQUARE_API=${USE_SQUARE_API},\
USE_FIRESTORE_CACHE=${USE_FIRESTORE_CACHE}"

echo "Printing ENV_VARS: ${ENV_VARS}"

echo "Building image: ${IMAGE}"
gcloud builds submit --tag "${IMAGE}"

echo "Deploying Cloud Run service: ${SERVICE_NAME} in region: ${REGION}"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --memory=1Gi \
  --concurrency=10 \
  --set-env-vars="${ENV_VARS}"

# Grab the *latest created* revision (not "latest ready" yet)
NEW_REVISION="$(gcloud run revisions list \
  --service "${SERVICE_NAME}" \
  --region "${REGION}" \
  --sort-by="~metadata.creationTimestamp" \
  --limit=1 \
  --format="value(metadata.name)")"

echo "Newest revision created: ${NEW_REVISION}"

echo "Waiting for revision to become Ready..."
# Wait up to ~5 minutes (60 * 5s) — adjust if you want
for i in {1..60}; do
  READY="$(gcloud run revisions describe "${NEW_REVISION}" \
    --region "${REGION}" \
    --format="value(status.conditions[?type=Ready].status)")"

  if [ "${READY}" = "True" ]; then
    echo "Revision is Ready: ${NEW_REVISION}"
    break
  fi

  echo "Not ready yet (${i}/60). Sleeping 5s..."
  sleep 5
done

# Double-check ready
READY="$(gcloud run revisions describe "${NEW_REVISION}" \
  --region "${REGION}" \
  --format="value(status.conditions[?type=Ready].status)")"

if [ "${READY}" != "True" ]; then
  echo "ERROR: Revision did not become Ready: ${NEW_REVISION}"
  echo "Tip: check logs: gcloud run services logs read ${SERVICE_NAME} --region ${REGION} --limit 50"
  exit 1
fi

echo "Switching traffic to: ${NEW_REVISION}"
gcloud run services update-traffic "${SERVICE_NAME}" \
  --region "${REGION}" \
  --to-revisions "${NEW_REVISION}=100"

echo "Traffic switched to: ${NEW_REVISION}"


