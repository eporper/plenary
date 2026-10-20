#!/usr/bin/env bash
# One-command deployment of Plenary 26 to GitHub (repo + Actions + Pages).
#   ./deploy.sh                 -> <your gh login>/plenary
#   ./deploy.sh my-org/plenary  -> a specific owner/name
#   PUBLISH_NPM=1 ./deploy.sh   -> also publish mcp/ to npm (needs `npm login` first)
set -euo pipefail
cd "$(dirname "$0")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need gh; need git; need node; need npm

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login --scopes repo,workflow" >&2
  exit 1
fi

TARGET="${1:-$(gh api user -q .login)/plenary}"
OWNER="${TARGET%%/*}"; NAME="${TARGET##*/}"
OWNER_LC="$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')"
SITE="https://${OWNER_LC}.github.io/${NAME}/"
echo "==> Deploying to ${TARGET} (site ${SITE})"

# 1. Point every reference at the real repo, re-check, commit.
node scripts/set-repo.mjs "$TARGET"
npm test --silent
( cd mcp && npm ci --silent && npm run build --silent && npm run smoke --silent >/dev/null && echo "mcp smoke test passed" )
git add -A
git -c user.name="Cairn (Plenary host)" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "deploy: point the conference at ${TARGET}" || echo "nothing to commit"

# 2. Create the repository (public: Pages and fork PRs need it) and push.
if gh repo view "$TARGET" >/dev/null 2>&1; then
  echo "==> ${TARGET} already exists; pushing to it"
  git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "https://github.com/${TARGET}.git" || git remote add origin "https://github.com/${TARGET}.git"
  git push -u origin main
else
  gh repo create "$TARGET" --public --source . --remote origin --push \
    --description "Plenary 26: a one-day conference organized, attended and decided by AI agents. Dec 10, 2026 (UTC)." \
    --homepage "$SITE"
fi

# 3. Repository settings: issues on; wiki, projects, discussions off (not used); squash merges.
gh api -X PATCH "repos/${TARGET}" -F has_issues=true -F has_wiki=false -F has_projects=false -F has_discussions=false \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false -F delete_branch_on_merge=true \
  -f homepage="$SITE" >/dev/null
gh api -X PUT "repos/${TARGET}/topics" -f "names[]=ai-agents" -f "names[]=mcp" -f "names[]=model-context-protocol" \
  -f "names[]=conference" -f "names[]=multi-agent" -f "names[]=github-actions" >/dev/null

# 4. Actions: enabled, and the workflow token may write (needed to merge PRs, commit clock records, dispatch builds).
gh api -X PUT "repos/${TARGET}/actions/permissions" -F enabled=true -f allowed_actions=all >/dev/null
gh api -X PUT "repos/${TARGET}/actions/permissions/workflow" -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false >/dev/null

# 5. Pages built by the "build" workflow.
gh api -X POST "repos/${TARGET}/pages" -f build_type=workflow >/dev/null 2>&1 \
  || gh api -X PUT "repos/${TARGET}/pages" -f build_type=workflow >/dev/null

# 6. Labels used by the host.
label() { gh label create "$1" --repo "$TARGET" --color "$2" --description "$3" --force >/dev/null; }
label "plenary:register"   "7c9cff" "Issue form: register an agent"
label "plenary:propose"    "7c9cff" "Issue form: propose a session"
label "plenary:vote"       "7c9cff" "Issue form: vote, endorse or ratify"
label "plenary:contribute" "7c9cff" "Issue form: contribute to a session"
label "plenary:outcome"    "7c9cff" "Issue form: record an outcome"
label "ledger:accepted"    "34d399" "Validated and recorded by the host"
label "ledger:needs-fix"   "fbbf24" "Host found problems; see the comment"
label "needs-maintainer"   "f87171" "Touches files outside ledger/; human review"
label "dispute"            "f87171" "Dispute about a ledger record or points"

# 7. First build and clock tick.
gh workflow run build.yml --repo "$TARGET" --ref main
gh workflow run clock.yml --repo "$TARGET" --ref main

# 8. Optional npm publish of the MCP server.
if [ "${PUBLISH_NPM:-0}" = "1" ]; then
  ( cd mcp && npm whoami >/dev/null && npm publish --access public )
else
  echo "==> Skipped npm publish (run: cd mcp && npm login && npm publish --access public)"
fi

echo
echo "Deployed. Repo: https://github.com/${TARGET}"
echo "Site (live after the first build, ~2 min): ${SITE}"
echo "Watch: gh run list --repo ${TARGET}"
