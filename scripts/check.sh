#!/usr/bin/env bash
# The check set of this repo. `just check` and the pipeline both run this file, so green means the same in both places.
#
#   scripts/check.sh          the sets the change touched. On main in the pipeline, every set
#   scripts/check.sh all      every set
#   scripts/check.sh <set>    one set
#   scripts/check.sh --plan   print the sets the change needs, and run none
#
# The three parts below are que-pasa's. The rest is the template's (shit-sdlc, templates/repo).
# Runs where Node is: in the workspace (crate run), or in the check of a push on the server.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. The sets, cheapest first. The first failure ends the run.
sets="notes code"

# 2. Each set's commands.
# The repo's notes, against their types.
set_notes() { npx basis lint; }
# The code: types, lint, format, tests, the build another project installs (dist/), and each of its exports from the packed tarball. A pipeline log is read after the run, so it names each test.
reporter="dot"
[ -z "${CI:-}" ] || reporter=verbose
set_code() {
  npx tsc --noEmit &&
    npx eslint &&
    npx prettier --check . &&
    scripts/workflows.test.sh &&
    npx vitest run --reporter="$reporter" &&
    npm run --silent build &&
    scripts/package.test.sh
}

# 3. The sets a changed file needs. A file no rule names needs every set, so a missing rule runs more, never less.
sets_for() {
  case "$1" in
    # The notes set reads every note. prettier skips Markdown (.prettierignore), so the code set reads none.
    *.md) echo notes ;;
    *) echo all ;;
  esac
}

# The files the change touched against the base: each commit since it left it, what is not committed yet, and what is
# not tracked yet. A renamed file counts at both of its paths.
changed() {
  local from
  from=$(git merge-base "${CHECK_BASE:-origin/main}" HEAD) || return 1
  git diff --name-only --no-renames "$from" || return 1
  git ls-files --others --exclude-standard
}

# Every set, when it cannot tell what changed, when nothing did, or on main in the pipeline: the full run that catches
# what a skip missed.
plan() {
  local files file need=""
  if [ "${GITHUB_REF:-}" = refs/heads/main ] || ! files=$(changed 2>/dev/null) || [ -z "$files" ]; then
    echo "$sets"
    return
  fi
  while IFS= read -r file; do
    need="$need $(sets_for "$file")"
  done <<<"$files"
  case " $need " in
    *" all "*)
      echo "$sets"
      return
      ;;
  esac
  local set out=""
  for set in $sets; do
    case " $need " in *" $set "*) out="$out $set" ;; esac
  done
  echo "${out# }"
}

# Packages, from the lockfile and frozen, when they are not current.
install() {
  [ ! -e package-lock.json ] || [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci
}

case "${1:-}" in
  "") todo=$(plan) ;;
  all) todo=$sets ;;
  --plan)
    plan
    exit 0
    ;;
  *)
    case " $sets " in
      *" $1 "*) todo=$1 ;;
      *)
        echo "usage: scripts/check.sh [all|--plan|$(echo "$sets" | tr ' ' '|')]" >&2
        exit 2
        ;;
    esac
    ;;
esac

install
for set in $todo; do
  echo "== $set"
  "set_$set" || {
    echo "check failed at: $set" >&2
    exit 1
  }
done
echo "check passed"
