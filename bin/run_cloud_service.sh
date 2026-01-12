#!/usr/bin/env bash
set -euo pipefail

# bin/run_cloud_service.sh
#
# Similar style to bin/run_cloud_job.sh:
# - build (Cloud Build)
# - deploy (Cloud Run service)
# - wait for latest revision Ready
# - shift traffic to latest revision
#
# IMPORTANT:
# - This script does NOT read local .env files by default (safer).
# - Prefer Cloud Run service env vars from Secret Manager.
# - If you still want to deploy with --set-env-vars, set USE_SET_ENV_VARS=1
#   and provide ENV_FILE or ensure the env vars are already in your shell.
#
# Usage:
#   ./bin/run_cloud_service.sh build
#   ./bin/run_cloud_service.sh deploy
#   ./bin/run_cloud_service.sh all
#
# Optional env overrides:
#   PROJECT_ID REGION SERVICE_NAME IMAGE
#   USE_SET_ENV_VARS=1 ENV_FILE=secrets/.env.deploy
#   ENV_VARS="KEY=VAL,KEY2=VAL2"   # if you want to pass explicitly

# ---------- Config ----------
PROJECT_ID="${PROJECT_ID:-square-inventory-480509}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-square-inventory-sync}"
IMAGE="${IMAGE:-gcr.io/${PROJECT_ID}/${SERVICE_NAME}}"

# Optional: set env vars on the service (NOT recommended for secrets)
USE_SET_ENV_VARS="${USE_SET_ENV_VARS:-0}"
ENV_FILE="${ENV_FILE:-secrets/.env.deploy}"   # only used if USE_SET_ENV_VARS=1 and ENV_VARS not set
ENV_VARS="${ENV_VARS:-}"                      # optional explicit KEY=VAL,KEY2=VAL2
# ----------------------------

die() { echo "❌ $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing dependency: $1"; }

usage() {
  cat <<EOF
Usage:
  $0 build
  $0 deploy
  $0 all

Defaults:
  PROJECT_ID=$PROJECT_ID
  REGION=$REGION
  SERVICE_NAME=$SERVICE_NAME
  IMAGE=$IMAGE

Optional env:
  USE_SET_ENV_VARS=1           (discouraged for secrets)
  ENV_FILE=$ENV_FILE           (dotenv-style file to load, only for USE_SET_ENV_VARS=1)
  ENV_VARS="K=V,K2=V2"         (explicit env var string for --set-env-vars)

Examples:
  $0 all
  PROJECT_ID=square-inventory-480509 REGION=us-central1 $0 all
  USE_SET_ENV_VARS=1 ENV_FILE=secrets/.env.deploy $0 deploy
EOF
}

# Load dotenv into current shell (safe-ish: supports quotes; ignores comments)
# NOTE: Avoid putting real secrets in files that may be committed.
load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || die "ENV_FILE not found: $file"

  echo "🔐 Loading env vars from $file (shell parsing rules apply)"
  # shellcheck disable=SC1090
  set -a
  . "$file"
  set +a
}

build_image() {
  echo "🔧 Building image: $IMAGE"
  gcloud config set project "$PROJECT_ID" >/dev/null
  gcloud builds submit --tag "$IMAGE"
  echo "✅ Build complete"
}

deploy_service() {
  echo "🚀 Deploying Cloud Run service: $SERVICE_NAME (region: $REGION)"
  gcloud config set project "$PROJECT_ID" >/dev/null

  local deploy_args=(
    run deploy "$SERVICE_NAME"
    --image "$IMAGE"
    --platform managed
    --region "$REGION"
    --allow-unauthenticated
    --memory=1Gi
    --concurrency=10
  )

  if [[ "$USE_SET_ENV_VARS" == "1" ]]; then
    # If ENV_VARS wasn't explicitly provided, optionally load from ENV_FILE and build ENV_VARS from known keys.
    if [[ -z "$ENV_VARS" ]]; then
      load_env_file "$ENV_FILE"

      # Build a comma-separated env var string (edit this list as needed)
      # NOTE: This will embed values into the Cloud Run service config. Avoid for secrets.
      ENV_VARS="APP_ENV=${APP_ENV:-},\
GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT:-},\
FIRESTORE_DATABASE_ID=${FIRESTORE_DATABASE_ID:-},\
SQUARE_ENV=${SQUARE_ENV:-},\
SQUARE_REDIRECT_URI=${SQUARE_REDIRECT_URI:-},\
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-},\
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-},\
GOOGLE_CALLBACK_URL=${GOOGLE_CALLBACK_URL:-},\
SESSION_SECRET=${SESSION_SECRET:-},\
ALLOWED_EMAILS=${ALLOWED_EMAILS:-},\
COST_SHEET_ID=${COST_SHEET_ID:-},\
COST_SHEET_RANGE=${COST_SHEET_RANGE:-},\
CRON_SECRET=${CRON_SECRET:-},\
OPENAI_API_KEY=${OPENAI_API_KEY:-},\
OPENAI_MODEL=${OPENAI_MODEL:-},\
SQUARE_ACCESS_TOKEN=${SQUARE_ACCESS_TOKEN:-},\
SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL:-},\
WINDOW_DAYS=${WINDOW_DAYS:-},\
IDEA_COUNT=${IDEA_COUNT:-},\
USE_SQUARE_API=${USE_SQUARE_API:-},\
USE_FIRESTORE_CACHE=${USE_FIRESTORE_CACHE:-}"
    fi

    echo "⚠️ USE_SET_ENV_VARS=1: applying --set-env-vars (discouraged for secrets)"
    # Avoid printing full ENV_VARS (may contain secrets)
    echo "   Setting env vars: (hidden)  [length=${#ENV_VARS}]"
    deploy_args+=(--set-env-vars="$ENV_VARS")
  else
    echo "ℹ️ Skipping --set-env-vars. Prefer Secret Manager env/secrets for production."
  fi

  gcloud "${deploy_args[@]}"
  echo "✅ Deploy command sent"
}

wait_and_shift_traffic() {
  echo "⏳ Waiting for newest revision to become Ready..."

  local new_rev
  new_rev="$(gcloud run revisions list \
    --service "$SERVICE_NAME" \
    --region "$REGION" \
    --sort-by="~metadata.creationTimestamp" \
    --limit=1 \
    --format="value(metadata.name)")"

  [[ -n "$new_rev" ]] || die "Could not determine newest revision"

  echo "Newest revision created: $new_rev"

  local ready="False"
  for i in $(seq 1 60); do
    ready="$(gcloud run revisions describe "$new_rev" \
      --region "$REGION" \
      --format="value(status.conditions[?type=Ready].status)")"

    if [[ "$ready" == "True" ]]; then
      echo "✅ Revision is Ready: $new_rev"
      break
    fi

    echo "Not ready yet ($i/60). Sleeping 5s..."
    sleep 5
  done

  if [[ "$ready" != "True" ]]; then
    echo "❌ Revision did not become Ready: $new_rev"
    echo "Tip: gcloud run services logs read $SERVICE_NAME --region $REGION --limit 50"
    exit 1
  fi

  echo "🔀 Switching traffic to: $new_rev"
  gcloud run services update-traffic "$SERVICE_NAME" \
    --region "$REGION" \
    --to-revisions "$new_rev=100"

  echo "✅ Traffic switched to: $new_rev"
}

main() {
  need gcloud

  [[ $# -ge 1 ]] || { usage; exit 1; }
  local action="$1"; shift || true

  if [[ $# -gt 0 && "$1" == "--" ]]; then
    shift
  fi

  case "$action" in
    build)
      build_image
      ;;
    deploy)
      deploy_service
      wait_and_shift_traffic
      ;;
    all)
      build_image
      deploy_service
      wait_and_shift_traffic
      ;;
    *)
      usage
      die "Unknown action: $action"
      ;;
  esac
}

main "$@"
