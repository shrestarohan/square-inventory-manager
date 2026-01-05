#!/usr/bin/env bash
set -euo pipefail

# bin/run_cloud_job.sh
#
# Build image, update Cloud Run Job, and execute it.
# Supports switching between .env and .env.deploy by swapping which Secret
# is mounted at /secrets/.env (Cloud Run Jobs cannot mount two different
# secrets into the same /secrets directory).
#
# Usage:
#   ./bin/run_cloud_job.sh build
#   ./bin/run_cloud_job.sh update
#   ./bin/run_cloud_job.sh execute
#   ./bin/run_cloud_job.sh all
#
# Switch env:
#   ./bin/run_cloud_job.sh execute -- ENV_FILE=.env.deploy
#   ./bin/run_cloud_job.sh all -- ENV_FILE=.env.deploy
#
# Override command:
#   ./bin/run_cloud_job.sh execute -- ENV_FILE=.env.deploy node /usr/src/app/scripts/fullNightlySync.js
#   ./bin/run_cloud_job.sh execute -- /bin/sync_firestore_db.sh
#
# Config via env vars:
#   PROJECT_ID REGION JOB IMAGE
#   DEFAULT_ENV_FILE ENV_SECRET_DEV ENV_SECRET_DEPLOY
#   SECRET_MOUNT_PATH

# ---------- Config ----------
PROJECT_ID="${PROJECT_ID:-square-inventory-480509}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-full-nightly-sync}"
IMAGE="${IMAGE:-gcr.io/${PROJECT_ID}/square-inventory-sync}"

DEFAULT_SCRIPT="${DEFAULT_SCRIPT:-scripts/fullNightlySync.js}"

DEFAULT_ENV_FILE="${DEFAULT_ENV_FILE:-.env}"
ENV_SECRET_DEV="${ENV_SECRET_DEV:-env-file}"               # Secret for .env
ENV_SECRET_DEPLOY="${ENV_SECRET_DEPLOY:-env-file-deploy}"  # Secret for .env.deploy

# Always mount exactly ONE secret to this path (swap which secret)
SECRET_MOUNT_PATH="${SECRET_MOUNT_PATH:-/secrets/.env}"
# ----------------------------

die() { echo "❌ $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing dependency: $1"; }

usage() {
  cat <<EOF
Usage:
  $0 build
  $0 update
  $0 execute [-- ENV_FILE=.env.deploy] [cmd...]
  $0 all [-- ENV_FILE=.env.deploy] [cmd...]

Defaults:
  PROJECT_ID=$PROJECT_ID
  REGION=$REGION
  JOB=$JOB
  IMAGE=$IMAGE
  DEFAULT_ENV_FILE=$DEFAULT_ENV_FILE
  SECRET_MOUNT_PATH=$SECRET_MOUNT_PATH
  DEFAULT_SCRIPT=$DEFAULT_SCRIPT

Env->Secret mapping:
  .env        -> $ENV_SECRET_DEV
  .env.deploy -> $ENV_SECRET_DEPLOY

Examples:
  $0 all
  $0 execute
  $0 execute -- ENV_FILE=.env.deploy
  $0 execute -- ENV_FILE=.env.deploy node $DEFAULT_SCRIPT
  $0 execute -- /bin/sync_firestore_db.sh
EOF
}

choose_env_secret() {
  local env_file="${1:-$DEFAULT_ENV_FILE}"
  case "$env_file" in
    .env)        echo "$ENV_SECRET_DEV" ;;
    .env.deploy) echo "$ENV_SECRET_DEPLOY" ;;
    *)
      die "Unsupported ENV_FILE=$env_file. Use .env or .env.deploy (or extend choose_env_secret())."
      ;;
  esac
}

build_image() {
  echo "🔧 Building image: $IMAGE"
  gcloud config set project "$PROJECT_ID" >/dev/null
  gcloud builds submit --tag "$IMAGE"
  echo "✅ Build complete"
}

# Generates an inline shell script that runs inside the container:
# - loads /secrets/.env (or whatever SECRET_MOUNT_PATH is)
# - validates required vars
# - runs the specified command
make_inline_wrapper() {
  cat <<'SH'
set -eu

ENV_PATH="__ENV_PATH__"
RUN_CMD="__RUN_CMD__"

echo "pwd=$(pwd)"
echo "ENV_PATH=$ENV_PATH"
ls -la /secrets || true

if [ ! -f "$ENV_PATH" ]; then
  echo "❌ Missing env file at $ENV_PATH"
  exit 1
fi

echo "✅ Loading env from $ENV_PATH"
head -n 3 "$ENV_PATH" || true

set -a
. "$ENV_PATH"
set +a

REQUIRED_VARS="OPENAI_API_KEY CRON_SECRET FIRESTORE_DATABASE_ID"
MISSING=""
for k in $REQUIRED_VARS; do
  eval "v=\${$k:-}"
  [ -n "$v" ] || MISSING="$MISSING $k"
done

if [ -n "$MISSING" ]; then
  echo "❌ ENV CHECK FAILED. Missing:$MISSING"
  exit 1
fi

echo "✅ ENV OK. Running: $RUN_CMD"
exec sh -lc "$RUN_CMD"
SH
}

update_job() {
  echo "🔧 Updating job: $JOB (region: $REGION)"
  gcloud config set project "$PROJECT_ID" >/dev/null

  local env_file="${ENV_FILE:-$DEFAULT_ENV_FILE}"
  local secret_name
  secret_name="$(choose_env_secret "$env_file")"

  # Default command for the job definition
  local run_cmd="node $DEFAULT_SCRIPT"

  # Build wrapper and inject values
  local wrapper
  wrapper="$(make_inline_wrapper)"
  wrapper="${wrapper//__ENV_PATH__/$SECRET_MOUNT_PATH}"
  wrapper="${wrapper//__RUN_CMD__/$run_cmd}"

  echo "   ENV_FILE=$env_file -> mounting secret $secret_name at $SECRET_MOUNT_PATH"
  echo "   Default CMD: $run_cmd"

  gcloud run jobs update "$JOB" \
    --region "$REGION" \
    --image "$IMAGE" \
    --update-secrets "${SECRET_MOUNT_PATH}=${secret_name}:latest" \
    --command "sh" \
    --args "-lc,$wrapper"

  echo "✅ Job updated"
}

execute_job() {
  gcloud config set project "$PROJECT_ID" >/dev/null

  local env_file="$DEFAULT_ENV_FILE"

  # Optional first arg: ENV_FILE=.env.deploy
  if [[ $# -gt 0 && "$1" == ENV_FILE=* ]]; then
    env_file="${1#ENV_FILE=}"
    shift
  fi

  local secret_name
  secret_name="$(choose_env_secret "$env_file")"

  # Default command for this run (if user doesn't override)
  local run_cmd="node $DEFAULT_SCRIPT"
  if [[ $# -gt 0 ]]; then
    run_cmd="$*"
  fi

  local wrapper
  wrapper="$(make_inline_wrapper)"
  wrapper="${wrapper//__ENV_PATH__/$SECRET_MOUNT_PATH}"
  wrapper="${wrapper//__RUN_CMD__/$run_cmd}"

  echo "🔧 Preparing execution:"
  echo "   ENV_FILE=$env_file -> secret=$secret_name"
  echo "   CMD=$run_cmd"

  # IMPORTANT: mount only ONE secret into /secrets by always mounting at SECRET_MOUNT_PATH
  gcloud run jobs update "$JOB" \
    --region "$REGION" \
    --update-secrets "${SECRET_MOUNT_PATH}=${secret_name}:latest" \
    --command "sh" \
    --args "-lc,$wrapper"

  echo "🚀 Executing job: $JOB"
  gcloud run jobs execute "$JOB" --region "$REGION"
  echo "✅ Execute triggered"
}

main() {
  need gcloud

  [[ $# -ge 1 ]] || { usage; exit 1; }
  local action="$1"; shift || true

  # Allow: execute -- ENV_FILE=... cmd...
  if [[ $# -gt 0 && "$1" == "--" ]]; then
    shift
  fi

  case "$action" in
    build) build_image ;;
    update) update_job ;;
    execute) execute_job "$@" ;;
    all)
      build_image
      update_job
      execute_job "$@"
      ;;
    *) usage; die "Unknown action: $action" ;;
  esac
}

main "$@"
