#!/usr/bin/env bash
# shellcheck disable=SC2329 # A function here is called by name: a case by the loop at the end, the rest by a case.
# shellcheck disable=SC2312 # An assertion reads a command's output; its exit is the assertion's, not the command's.
# shellcheck disable=SC2016 # The cases hold GitHub's expressions as text: a pattern is literal.
# The tests of the dev-image workflow, read as text: when it starts, what it may write, that it gets crate from its
# release with a limit, and that each action is pinned. crate's own dev-image verbs are tested in crate.
# Run it from anywhere: scripts/workflows.test.sh. One ok or not ok line per case, exit 1 if any fails.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$here/..

fail() {
  echo "not ok - ${name:-a case}"
  printf '  %s\n' "$@"
  exit 1
}
miss() {
  echo "not ok - $name"
  printf '  %s\n' "$@"
  return 1
}
then_is() { [ "$2" = "$3" ] || miss "$1: expected $(printf %q "$2"), got $(printf %q "$3")"; }
then_has() { grep -qF -- "$2" <<<"$3" || miss "$1: expected to hold $(printf %q "$2")"; }
pass() { echo "ok - $name"; }

# The lines of $wf with no comment lines and no blank lines.
wf_lines() { grep -vE '^\s*(#|$)' "$wf"; }
# list_in <key regex>: stdin's `- item` lines of the block list under the first line matching the key.
list_in() {
  awk -v k="$1" '
    found && /^ *- / { sub(/^ *- */, ""); sub(/ *#.*/, ""); print; next }
    found { exit }
    $0 ~ k { found = 1 }'
}
# block_in <key regex>: stdin's lines indented under the first line matching the key.
block_in() {
  awk -v k="$1" '
    found { match($0, /^ */); if (RLENGTH <= ind) exit; print; next }
    $0 ~ k { found = 1; match($0, /^ */); ind = RLENGTH }'
}
list_under() { wf_lines | list_in "$1"; }
block() { wf_lines | block_in "$1"; }
present() { [ -f "$wf" ] && echo present || echo missing; }
given_workflow() { wf=$root/.github/workflows/${1:-dev-image.yml}; }
# inputs: crate.toml's [dev] inputs, one per line.
inputs() { sed -n 's/^inputs = \[\(.*\)\]/\1/p' "$root/crate.toml" | tr ',' '\n' | sed 's/^ *"//; s/" *$//'; }

test_the_workflow_starts_on_main_and_the_inputs() {
  name="the workflow starts on a push to main that changes crate.toml or an input, and by hand"
  given_workflow
  want=$( (inputs; printf '%s\n' crate.toml scripts/dev-image-smoke.sh .github/workflows/dev-image.yml) | sort -u)
  then_is "the workflow file" "present" "$(present)" &&
    then_is "on.push.branches" "main" "$(block '^  push:' | sed -n 's/^ *branches: *\[\(.*\)\]$/\1/p')" &&
    then_is "on.push.paths" "$want" "$(list_under '^    paths:' | sort -u)" &&
    then_has "the triggers" "workflow_dispatch:" "$(block '^on:')" &&
    pass
}

test_only_the_image_job_writes() {
  name="the workflow reads by default, and only its image job may write packages, on main"
  given_workflow
  then_is "the workflow file" "present" "$(present)" &&
    then_is "the top-level permissions" "contents: read" "$(block '^permissions:' | sed 's/^ *//')" &&
    then_is "the image job's permissions" "$(printf '%s\n' 'contents: read' 'packages: write')" \
      "$(block '^    permissions:' | sed 's/^ *//')" &&
    then_has "the image job" "timeout-minutes:" "$(block '^  image:')" &&
    then_has "the image job" "if: github.ref == 'refs/heads/main'" "$(block '^  image:')" &&
    pass
}

test_the_job_gets_crate_then_logs_in_ensures_and_promotes() {
  name="the image job gets crate from its release with a limit, logs in with its own token, then ensures and promotes"
  given_workflow
  then_is "the workflow file" "present" "$(present)" || return 1
  steps=$(block '^    steps:')
  line() { grep -nF -- "$1" <<<"$steps" | head -1 | cut -d: -f1; }
  get=$(line 'curl -fsSL --max-time 120 https://github.com/matta-kelly/crate/releases/download/v2/crate-linux-amd64.tar.gz')
  login=$(line 'podman login ghcr.io')
  ensure=$(line 'run: crate dev-image ensure')
  promote=$(line 'run: crate dev-image promote')
  then_has "the steps" 'TOKEN: ${{ secrets.GITHUB_TOKEN }}' "$steps" &&
    { [ -n "$get" ] && [ -n "$login" ] && [ -n "$ensure" ] && [ -n "$promote" ] &&
      [ "$get" -lt "$ensure" ] && [ "$login" -lt "$ensure" ] && [ "$ensure" -lt "$promote" ] ||
      miss "the steps: expected crate and the login before ensure, then promote; got lines [$get] [$login] [$ensure] [$promote]"; } &&
    pass
}

test_each_action_is_pinned() {
  name="each action the workflow uses is pinned to a full commit hash"
  given_workflow
  then_is "the workflow file" "present" "$(present)" || return 1
  uses=$(wf_lines | grep -E '^\s*-?\s*uses:')
  bad=$(grep -vE 'uses: [^@ ]+@[0-9a-f]{40}( |$)' <<<"$uses" || true)
  then_is "the unpinned uses" "" "$bad" &&
    { [ -n "$uses" ] || miss "the workflow: expected it to use an action, got none"; } &&
    pass
}

failed=0
for t in $(declare -F | awk '$3 ~ /^test_/ {print $3}'); do
  ("$t") || failed=1
done
exit "$failed"
