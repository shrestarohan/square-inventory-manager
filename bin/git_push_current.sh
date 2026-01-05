#!/usr/bin/env bash
set -euo pipefail

# bin/git_push_current.sh
#
# Features:
# - Abort if branch is main or prod
# - Auto stage + commit (only if there are changes)
# - Auto pull --rebase before push
# - Push to origin/current-branch
# - Print last commit SHA after push
# - Slack notification code included but DISABLED by default
#
# Usage:
#   bin/git_push_current.sh "feat: update cloud run job runner"
#
# Optional env vars:
#   ENABLE_SLACK=1
#   SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."

die() { echo "❌ $*" >&2; exit 1; }

# Ensure we're in a git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Not inside a git repository"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "HEAD" ]] || die "Detached HEAD state. Checkout a branch first."

# Abort on protected branches
case "$BRANCH" in
  main|prod)
    die "Refusing to push from protected branch: $BRANCH"
    ;;
esac

MSG="${1:-"chore: update code"}"

echo "📍 Branch: $BRANCH"
echo "📝 Commit message: $MSG"
echo "-----------------------------"
git status
echo "-----------------------------"

# Stage everything
git add -A

# Commit only if there are staged changes
if git diff --cached --quiet; then
  echo "ℹ️ No changes to commit."
else
  git commit -m "$MSG"
fi

echo "🔄 Fetching + rebasing on origin/$BRANCH ..."
git fetch origin "$BRANCH" || true

# Rebase if remote exists; otherwise skip
if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git pull --rebase origin "$BRANCH"
else
  echo "ℹ️ No remote branch origin/$BRANCH found yet. Skipping rebase."
fi

# If rebase caused conflicts, stop here
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working tree not clean after rebase (likely conflicts). Resolve and retry."
  git status
  exit 1
fi

echo "🚀 Pushing to origin/$BRANCH ..."
git push origin "$BRANCH"

SHA="$(git rev-parse HEAD)"
echo "✅ Push complete. HEAD is $SHA"

# ------------------------------
# Slack notification (DISABLED)
# ------------------------------
ENABLE_SLACK="${ENABLE_SLACK:-0}"
if [[ "$ENABLE_SLACK" == "1" ]]; then
  [[ -n "${SLACK_WEBHOOK_URL:-}" ]] || die "ENABLE_SLACK=1 but SLACK_WEBHOOK_URL is not set"

  REPO="$(basename "$(git rev-parse --show-toplevel)")"
  SHORT_SHA="${SHA:0:7}"
  TEXT="Pushed \`${REPO}\` branch \`${BRANCH}\` @ \`${SHORT_SHA}\`"

  curl -sS -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"${TEXT}\"}" \
    "$SLACK_WEBHOOK_URL" >/dev/null

  echo "📣 Slack notified."
fi
