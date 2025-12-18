et -euo pipefail

MSG="${1:-}"

if [[ -z "$MSG" ]]; then
	  echo "Usage: ./gpush.sh \"commit message\""
	    exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REMOTE="${2:-origin}"

echo "➡️  Branch: $BRANCH"
echo "➡️  Remote: $REMOTE"

git status --porcelain
git add .

if git diff --cached --quiet; then
	  echo "ℹ️  Nothing staged to commit."
	    exit 0
fi

git commit -m "$MSG"

echo "🚀 Pushing to: $REMOTE/$BRANCH"
git push -u "$REMOTE" "$BRANCH"

echo "✅ Done: pushed to $REMOTE/$BRANCH"

