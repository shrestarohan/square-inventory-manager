#!/usr/bin/env bash
set -euo pipefail

PROJECT=""
SOURCE_DB=""
TARGET_DB=""
BUCKET=""
PREFIX="firestore-sync"
AUTO_YES="0"
LIST_DBS="0"
DRY_RUN="0"

# NEW: recreate | import-only
MODE="recreate"

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "ℹ️  $*"; }
ok() { echo "✅ $*"; }

usage() {
  cat <<EOF
Usage:
  $0 --project PROJECT_ID --source-db SOURCE_DB --target-db TARGET_DB --bucket gs://BUCKET
     [--prefix PATH] [--mode recreate|import-only] [--yes] [--dry-run] [--list-dbs]

Modes:
  recreate     Export -> (if target exists) delete DB -> create DB -> import  (DEFAULT; makes target identical)
  import-only  Export -> import only (does NOT delete DB; may leave extra docs in target)

Notes:
  - TARGET_DB must be a named Firestore database. This script refuses "(default)".
  - Firestore DB create requires --location; script reads locationId from SOURCE_DB.
EOF
}

# ---- Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2;;
    --source-db) SOURCE_DB="$2"; shift 2;;
    --target-db) TARGET_DB="$2"; shift 2;;
    --bucket) BUCKET="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    --yes) AUTO_YES="1"; shift 1;;
    --dry-run) DRY_RUN="1"; shift 1;;
    --list-dbs) LIST_DBS="1"; shift 1;;
    --prod-db) SOURCE_DB="$2"; shift 2;;   # alias
    -h|--help) usage; exit 0;;
    *) die "Unknown argument: $1";;
  esac
done

command -v gcloud >/dev/null 2>&1 || die "gcloud not found in PATH."

if [[ "$LIST_DBS" == "1" ]]; then
  [[ -n "$PROJECT" ]] || die "--project is required for --list-dbs"
  gcloud config set project "$PROJECT" >/dev/null
  gcloud firestore databases list
  exit 0
fi

[[ -n "$PROJECT" ]] || die "Missing --project"
[[ -n "$SOURCE_DB" ]] || die "Missing --source-db"
[[ -n "$TARGET_DB" ]] || die "Missing --target-db"
[[ -n "$BUCKET" ]] || die "Missing --bucket (gs://...)"

if [[ "$BUCKET" != gs://* ]]; then
  die "--bucket must be like gs://your-bucket"
fi

if [[ "$TARGET_DB" == "(default)" ]]; then
  die "TARGET_DB is '(default)'. This script refuses to delete/recreate (default). Use a named DB as target."
fi

if [[ "$MODE" != "recreate" && "$MODE" != "import-only" ]]; then
  die "--mode must be 'recreate' or 'import-only'"
fi

# ---- Set project
info "Using project: $PROJECT"
gcloud config set project "$PROJECT" >/dev/null

# ---- Confirm source exists; target may or may not exist
info "Checking Firestore databases..."
DB_LIST="$(gcloud firestore databases list --format='value(name)' || true)"

echo "$DB_LIST" | grep -q "/databases/${SOURCE_DB}\$" \
  || die "SOURCE_DB '$SOURCE_DB' not found. Run with --list-dbs."

TARGET_EXISTS="0"
if echo "$DB_LIST" | grep -q "/databases/${TARGET_DB}\$"; then
  TARGET_EXISTS="1"
fi

# ---- Determine location from source (required for create)
SRC_LOCATION="$(gcloud firestore databases describe --database="$SOURCE_DB" --format='value(locationId)' || true)"
[[ -n "${SRC_LOCATION// }" ]] || die "Could not read locationId from source DB '$SOURCE_DB'."
info "Source DB locationId: $SRC_LOCATION"

# ---- Build export path
TS="$(date +%Y%m%d-%H%M%S)"
EXPORT_PATH="${BUCKET%/}/${PREFIX%/}/export-${SOURCE_DB}-to-${TARGET_DB}-${TS}"

cat <<EOF
============================================================
Firestore DB Sync Plan
  Project:       $PROJECT
  SOURCE_DB:     $SOURCE_DB
  TARGET_DB:     $TARGET_DB
  Mode:          $MODE
  Target exists: $TARGET_EXISTS
  Location:      $SRC_LOCATION
  Export to:     $EXPORT_PATH
  Dry run:       $DRY_RUN
============================================================
EOF

# ---- Dry run: print plan only
if [[ "$DRY_RUN" == "1" ]]; then
  echo "--dry-run enabled: no changes will be made."
  echo
  echo "Would run:"
  echo "  gcloud firestore export \"$EXPORT_PATH\" --database=\"$SOURCE_DB\""

  if [[ "$MODE" == "recreate" ]]; then
    if [[ "$TARGET_EXISTS" == "1" ]]; then
      echo "  gcloud firestore databases delete --database=\"$TARGET_DB\" --quiet"
    fi
    echo "  gcloud firestore databases create --database=\"$TARGET_DB\" --location=\"$SRC_LOCATION\""
  else
    echo "  # import-only: no DB delete/create"
  fi

  echo "  gcloud firestore import \"$EXPORT_PATH\" --database=\"$TARGET_DB\""
  ok "Dry run complete."
  exit 0
fi

# ---- Confirm destructive action (only if recreate and target exists)
if [[ "$MODE" == "recreate" && "$TARGET_EXISTS" == "1" && "$AUTO_YES" != "1" ]]; then
  read -r -p "Type 'DELETE ${TARGET_DB}' to continue: " CONFIRM
  [[ "$CONFIRM" == "DELETE ${TARGET_DB}" ]] || die "Confirmation failed. Aborting."
fi

# ---- Export source
info "Exporting SOURCE_DB '$SOURCE_DB'..."
gcloud firestore export "$EXPORT_PATH" --database="$SOURCE_DB"
ok "Export completed."

# ---- Target handling
if [[ "$MODE" == "recreate" ]]; then
  if [[ "$TARGET_EXISTS" == "1" ]]; then
    info "Deleting existing TARGET_DB '$TARGET_DB'..."
    gcloud firestore databases delete --database="$TARGET_DB" --quiet
    ok "Target database deleted."
  else
    info "TARGET_DB '$TARGET_DB' does not exist; will create it."
  fi

  info "Creating TARGET_DB '$TARGET_DB' in location '$SRC_LOCATION'..."
  gcloud firestore databases create --database="$TARGET_DB" --location="$SRC_LOCATION"
  ok "Target database created."
else
  info "Mode=import-only: skipping DB delete/create. Importing over existing data."
fi

# ---- Import into target
info "Importing into TARGET_DB '$TARGET_DB'..."
gcloud firestore import "$EXPORT_PATH" --database="$TARGET_DB"
ok "Import completed."

cat <<EOF
============================================================
✅ SUCCESS
Source DB:  $SOURCE_DB
Target DB:  $TARGET_DB
Mode:       $MODE
Export:     $EXPORT_PATH
============================================================
EOF
