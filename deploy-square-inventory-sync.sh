#!/usr/bin/env bash

# deploy-square-inventory-sync.sh
# Usage:
#   ./deploy-square-inventory-sync.sh YOUR_PROJECT_ID [REGION]
#
# Example:
#   ./deploy-square-inventory-sync.sh my-gcp-project us-central1

set -e

PROJECT_ID="$1"
REGION="${2:-us-central1}"   # default region is us-central1
SERVICE_NAME="square-inventory-sync"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
ENV_FILE=".env.deploy"

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

echo "Building image: ${IMAGE}"
gcloud builds submit --tag "${IMAGE}"

# Build a single --set-env-vars string so gcloud parses it cleanly
ENV_VARS="SQUARE_REDIRECT_URI=${SQUARE_REDIRECT_URI},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET},GOOGLE_CALLBACK_URL=${GOOGLE_CALLBACK_URL},SESSION_SECRET=${SESSION_SECRET},ALLOWED_EMAILS=${ALLOWED_EMAILS}"

echo "Deploying Cloud Run service: ${SERVICE_NAME} in region: ${REGION}"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --memory=1Gi \
  --concurrency=10 \
  --set-env-vars="${ENV_VARS}"

echo "Done."
