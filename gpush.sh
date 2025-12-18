#!/usr/bin/env bash
set -euo pipefail

MSG="${1:-}"

if [[ -z "$MSG" ]]; then
  echo "Usage: ./scripts/gpush.sh \"commit message\""
  exit 1
fi

git status --porcelain
git add .
git commit -m "$MSG" || {
  echo "Nothing to commit."
  exit 0
}

# push current branch to its upstream if set; otherwise set upstream to origin/<branch>
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push -u origin "$BRANCH"

