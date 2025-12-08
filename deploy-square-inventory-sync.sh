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

if [ -z "$PROJECT_ID" ]; then
  echo "Error: PROJECT_ID is required."
  echo "Usage: $0 YOUR_PROJECT_ID [REGION]"
  exit 1
fi

# Optional: load deployment env vars from .env.deploy (DO NOT commit this to git)
if [ -f ".env.deploy" ]; then
  echo "Loading env vars from .env.deploy"
  # This will export lines like KEY=VALUE, ignoring comments
  export $(grep -v '^#' .env.deploy | xargs)
fi

echo "Building image: ${IMAGE}"
gcloud builds submit --tag "${IMAGE}"

echo "Deploying Cloud Run service: ${SERVICE_NAME} in region: ${REGION}"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars=SQUARE_APP_ID="${SQUARE_APP_ID}",SQUARE_APP_SECRET="${SQUARE_APP_SECRET}",SQUARE_ENV="${SQUARE_ENV:-sandbox}" \
  --set-env-vars=SQUARE_REDIRECT_URI="${SQUARE_REDIRECT_URI}" \
  --set-env-vars=GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}",GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET}" \
  --set-env-vars=GOOGLE_CALLBACK_URL="${GOOGLE_CALLBACK_URL}" \
  --set-env-vars=SESSION_SECRET="${SESSION_SECRET}",ALLOWED_EMAILS="${ALLOWED_EMAILS}"

echo "Done."
