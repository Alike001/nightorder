#!/usr/bin/env bash
set -euo pipefail
command -v gh >/dev/null || { echo 'Install GitHub CLI (gh) first'; exit 1; }
gh auth status >/dev/null 2>&1 || { echo 'Run gh auth login first'; exit 1; }
gh repo view >/dev/null || { echo 'Run from repository root with an origin GitHub remote'; exit 1; }
shopt -s nullglob
for file in issues/*.md; do
  title=$(head -n 1 "$file" | sed 's/^# //')
  if gh issue list --state all --limit 300 --json title --jq '.[].title' | grep -Fxq "$title"; then
    echo "Already exists: $title"
  else
    echo "Creating: $title"
    gh issue create --title "$title" --body-file "$file"
  fi
done
