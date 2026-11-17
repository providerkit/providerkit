#!/usr/bin/env bash
# Publish through a PR, using the same Git and GitHub credentials as the maintainer.
set -euo pipefail
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --check ) ]]; then
  printf 'Usage: bun run profile:pr [--check]\n' >&2
  exit 2
fi
cd "$(dirname "$0")/.."

# A fork's origin must never supply content for the public organization.
git fetch --quiet https://github.com/providerkit/providerkit.git main
source_commit=$(git rev-parse FETCH_HEAD)
profile_tree=$(git rev-parse "$source_commit:brand/profile")
branch="profile-${profile_tree:0:12}"
repo=providerkit/.github
checkout=$(mktemp -d)
trap 'rm -rf -- "$checkout"' EXIT

gh repo clone "$repo" "$checkout" -- --branch main --depth 1 --quiet
git -C "$checkout" switch --quiet -c "$branch"
files=(profile/README.md profile/README.pt-BR.md profile/README.es.md)
for file in "${files[@]}"; do
  git show "$source_commit:brand/$file" > "$checkout/$file"
done
cd "$checkout"
git add -- "${files[@]}"
if [[ ${1:-} == --check ]]; then
  git diff --cached --exit-code --name-only
  exit 0
fi
if git diff --cached --quiet; then
  printf 'The GitHub profile already matches the monorepo.\n'
  exit 0
fi

open_pr=$(gh pr list --repo "$repo" --head "$branch" --json url --jq '.[0].url // empty')
if [[ -n "$open_pr" ]]; then
  printf '%s\n' "$open_pr"
  exit 0
fi

git commit --quiet -m "docs(profile): update the organization profile" \
  -m "Publish the three profile pages from providerkit/providerkit commit $source_commit. The mark stays in the main repository."
git push origin "HEAD:refs/heads/$branch"
gh pr create --repo "$repo" --draft --base main --head "$branch" \
  --title "docs(profile): update the organization profile" \
  --body "Publish the [English, Portuguese and Spanish pages from the monorepo](https://github.com/providerkit/providerkit/tree/$source_commit/brand/profile)."
