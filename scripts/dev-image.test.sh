#!/usr/bin/env bash
# shellcheck disable=SC2329 # A function here is called by name: a case by the loop at the end, the rest by a case.
# shellcheck disable=SC2312 # An assertion reads a command's output; its exit is the assertion's, not the command's.
# shellcheck disable=SC2016 # The workflow cases hold GitHub's expressions as text: a pattern is literal.
# The tests of scripts/dev-image.sh and of the workflows that call it, on one machine, with no image, no
# registry and no network. Each script case makes a temp git repo that holds the three inputs and a copy of
# the script, and puts stand-in `skopeo` and `podman` first on PATH. Each stand-in appends its arguments as
# one line to $T/calls.
# The registry is $T/registry, one `<tag> <digest>` per line: `skopeo inspect` answers a tag listed
# there, and `skopeo copy` and `podman push` add their target tag to it. This machine's store is
# $T/local, one tag per line: `podman build -t`, `podman tag` and `podman pull` add a tag, `podman
# image exists` reads it, and `podman image rm` removes one. The smoke is a stand-in too
# (DEV_IMAGE_SMOKE), which exits $SMOKE_EXIT.
# Each case exports ENGINE=podman beside its stand-in podman, so an ENGINE in the caller's environment
# (`ENGINE=docker scripts/dev-image.test.sh`, as a CI sets it) cannot point these tests at a real engine.
# Run it from anywhere: scripts/dev-image.test.sh. One ok or not ok line per case, exit 1 if any fails.
set -uo pipefail
out='' err='' code=0

here=$(cd "$(dirname "$0")" && pwd -P)
script=$here/dev-image.sh
name_=example.test/que-pasa-dev
inputs=(.devcontainer/devcontainer.json .devcontainer/Containerfile package-lock.json)

# given: a git repo with the three inputs committed, and the stand-ins on PATH.
given_repo() {
  T=$(mktemp -d) || return 1
  repo=$T/repo
  mkdir -p "$repo/scripts" "$repo/.devcontainer" "$T/bin" || return 1
  cp "$script" "$repo/scripts/dev-image.sh" || return 1
  for f in "${inputs[@]}"; do echo "$f v1" >"$repo/$f"; done
  echo readme >"$repo/README.md"
  git -C "$repo" init -q &&
    git -C "$repo" -c user.email=t@t -c user.name=t add -A &&
    git -C "$repo" -c user.email=t@t -c user.name=t commit -qm init || return 1
  : >"$T/calls"
  : >"$T/registry"
  : >"$T/local"
  cat >"$T/bin/skopeo" <<'STUB'
#!/usr/bin/env bash
# A stand-in for skopeo: inspect answers a tag in $T/registry; copy adds its target to it.
echo "skopeo $*" >>"$T/calls"
case $1 in
inspect)
  ref=${!#}; ref=${ref#docker://}
  d=$(awk -v r="$ref" '$1 == r {print $2}' "$T/registry" | tail -1)
  [ -n "$d" ] || { echo "manifest unknown: $ref" >&2; exit 1; }
  echo "$d"
  ;;
copy)
  src=${*: -2:1}; dst=${!#}; src=${src#docker://}; dst=${dst#docker://}
  d=$(awk -v r="$src" '$1 == r {print $2}' "$T/registry" | tail -1)
  [ -n "$d" ] || exit 1
  echo "$dst $d" >>"$T/registry"
  ;;
esac
STUB
  cat >"$T/bin/podman" <<'STUB'
#!/usr/bin/env bash
# A stand-in for podman: push adds the tag to $T/registry with a new digest; build, tag and pull of
# a tag in the registry add the tag to this machine's store, $T/local; `image exists` reads that
# store, and `image rm` removes a tag from it.
echo "podman $*" >>"$T/calls"
case $1 in
push) echo "$2 sha256:$(echo "$2" | sha256sum | cut -c1-64)" >>"$T/registry" ;;
build) echo "${*: -2:1}" >>"$T/local" ;;
tag)
  grep -qxF -- "$2" "$T/local" || exit 1
  echo "$3" >>"$T/local"
  ;;
pull) awk -v r="$2" '$1 == r {f=1} END {exit !f}' "$T/registry" && echo "$2" >>"$T/local" || exit 1 ;;
image)
  case $2 in
  exists) grep -qxF -- "$3" "$T/local" ;;
  rm)
    grep -vxF -- "$3" "$T/local" >"$T/local.new"
    mv "$T/local.new" "$T/local"
    ;;
  esac
  ;;
esac
STUB
  cat >"$T/smoke" <<'STUB'
#!/usr/bin/env bash
echo "smoke $*" >>"$T/calls"
exit "${SMOKE_EXIT:-0}"
STUB
  chmod +x "$T/bin/skopeo" "$T/bin/podman" "$T/smoke" || return 1
  export T PATH="$T/bin:$PATH" DEV_IMAGE=$name_ DEV_IMAGE_SMOKE=$T/smoke SMOKE_EXIT=0 ENGINE=podman
}

commit() { git -C "$repo" -c user.email=t@t -c user.name=t commit -qam "$1"; }
digest() { echo "sha256:$(printf '%064d' "$1")"; }

# run <args>: runs the script in the repo with them; sets out, err and code.
run() {
  out=$("$repo/scripts/dev-image.sh" "$@" 2>"$T/err")
  code=$?
  err=$(cat "$T/err")
}
when() { run "$1"; }

# fail <why>: a case whose setup failed, named as the case it is, and ended there.
fail() {
  echo "not ok - ${name:-a case}"
  printf '  %s\n' "$@"
  exit 1
}
hash_now() { "$repo/scripts/dev-image.sh" hash 2>/dev/null; }
# pushed <tag>: the digest the stand-in podman pushes <tag> with, a hash of the tag.
pushed() { echo "sha256:$(echo "$1" | sha256sum | cut -c1-64)"; }
# registry_digest <tag>: the digest $T/registry holds for <tag>, or empty.
registry_digest() { awk -v r="$1" '$1 == r {print $2}' "$T/registry" | tail -1; }

miss() {
  echo "not ok - $name"
  printf '  %s\n' "$@"
  printf '  | stdout: %s\n  | stderr: %s\n' "$out" "$err"
  sed 's/^/  | call: /' "$T/calls"
  return 1
}
then_is() { [ "$2" = "$3" ] || miss "$1: expected $(printf %q "$2"), got $(printf %q "$3")"; }
then_has() { grep -qF -- "$2" <<<"$3" || miss "$1: expected to hold $(printf %q "$2")"; }
then_lacks() { ! grep -qF -- "$2" <<<"$3" || miss "$1: expected not to hold $(printf %q "$2")"; }
then_lacks_local() { ! grep -qxF -- "$2" "$T/local" || miss "$1: expected $(printf %q "$2") not on this machine"; }
calls() { cat "$T/calls"; }
pass() { echo "ok - $name"; }

# --- hash ---

test_hash_is_stable() {
  name="hash prints the same 16 hex characters twice"
  given_repo || fail "setup: the repo"
  when hash
  first=$out
  when hash
  then_is "the exit" 0 "$code" &&
    then_is "the second hash" "$first" "$out" &&
    { [[ $out =~ ^[0-9a-f]{16}$ ]] || miss "the hash: expected 16 lowercase hex, got $out"; } &&
    pass
}

test_hash_fails_on_a_missing_input() {
  name="hash fails, naming the input, when one is missing"
  given_repo || fail "setup: the repo"
  git -C "$repo" rm -q package-lock.json || fail "setup: the removal of package-lock.json"
  commit "rm" || fail "setup: the commit"
  when hash
  { [ "$code" -ne 0 ] || miss "the exit: expected non-zero, got 0"; } &&
    then_has "stderr" "package-lock.json" "$err" &&
    pass
}

test_hash_follows_each_input() {
  name="hash changes when any one of the three inputs changes"
  given_repo || fail "setup: the repo"
  for f in "${inputs[@]}"; do
    before=$(hash_now)
    echo "$f changed" >>"$repo/$f" || fail "setup: the change to $f"
    commit "$f" || fail "setup: the commit of $f"
    after=$(hash_now)
    [ "$before" != "$after" ] || { miss "the hash did not change with $f"; return 1; }
  done
  pass
}

test_hash_ignores_other_files() {
  name="hash stays the same when only README.md changes"
  given_repo || fail "setup: the repo"
  before=$(hash_now)
  [ -n "$before" ] || { miss "the hash: expected one, got none"; return 1; }
  echo more >>"$repo/README.md" || fail "setup: the change to README.md"
  commit readme || fail "setup: the commit"
  then_is "the hash" "$before" "$(hash_now)" && pass
}

# --- ensure ---

test_ensure_builds_nothing_when_the_tag_exists() {
  name="ensure builds nothing when ghcr has the tag, and still points :main at it"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  echo "$name_:$h $(digest 7)" >>"$T/registry"
  when ensure
  then_is "the exit" 0 "$code" &&
    then_lacks "the calls" "podman build" "$(calls)" &&
    then_lacks "the calls" "podman push" "$(calls)" &&
    then_lacks "the calls" "smoke" "$(calls)" &&
    then_is "stdout's last line" "$name_@$(digest 7)" "$(tail -1 <<<"$out")" &&
    then_has "stderr" "$name_:$h exists: not built" "$err" &&
    then_is "the digest :main points at" "$(digest 7)" "$(registry_digest "$name_:main")" &&
    pass
}

test_ensure_builds_smokes_and_pushes_when_the_tag_is_missing() {
  name="ensure builds a candidate, smokes it, tags and pushes it in order, and points :main at it"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  when ensure
  want=$(printf '%s\n' \
    "podman build -f .devcontainer/Containerfile -t $name_:$h-candidate ." \
    "smoke $name_:$h-candidate" \
    "podman tag $name_:$h-candidate $name_:$h" \
    "podman push $name_:$h")
  got=$(grep -E '^(podman (build|tag|push)|smoke)' "$T/calls")
  then_is "the exit" 0 "$code" &&
    then_is "the calls, in order" "$want" "$got" &&
    then_has "the calls" "podman image rm $name_:$h-candidate" "$(calls)" &&
    then_is "the ref" "$name_@$(pushed "$name_:$h")" "$(tail -1 <<<"$out")" &&
    then_is "the digest :main points at" "$(pushed "$name_:$h")" "$(registry_digest "$name_:main")" &&
    pass
}

test_ensure_moves_nothing_on_a_failed_smoke() {
  name="ensure pushes nothing and moves :main nowhere when the smoke fails"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  echo "$name_:main $(digest 5)" >>"$T/registry"
  export SMOKE_EXIT=1
  when ensure
  { [ "$code" -ne 0 ] || miss "the exit: expected non-zero, got 0"; } &&
    then_has "the calls" "smoke $name_:$h-candidate" "$(calls)" &&
    then_lacks "the calls" "podman push" "$(calls)" &&
    then_is "the digest :main points at" "$(digest 5)" "$(registry_digest "$name_:main")" &&
    then_is "the digest of the commit's tag" "" "$(registry_digest "$name_:$h")" &&
    pass
}

# --- a failed smoke leaves no image ---

test_a_failed_smoke_leaves_no_image() {
  name="a failed smoke leaves no <name>:<hash> on this machine, after ensure or local"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  export SMOKE_EXIT=1
  when ensure
  ensure_code=$code
  ensure_smokes=$(grep -c '^smoke' "$T/calls")
  when local
  local_code=$code
  { [ "$ensure_code" -ne 0 ] || miss "ensure's exit: expected non-zero, got $ensure_code"; } &&
    then_is "the smokes ensure ran" 1 "$ensure_smokes" &&
    then_lacks_local "this machine after a failed ensure" "$name_:$h" &&
    { [ "$local_code" -ne 0 ] || miss "local's exit: expected non-zero, got $local_code"; } &&
    then_is "the smokes ensure and local ran" 2 "$(grep -c '^smoke' "$T/calls")" &&
    then_lacks_local "this machine after a failed local" "$name_:$h" &&
    then_lacks_local "this machine after both" "$name_:$h-candidate" &&
    pass
}

test_a_failed_smoke_does_not_leave_a_good_image() {
  name="local builds again after a failed smoke, and gives out the tag then"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  export SMOKE_EXIT=1
  when local
  first_code=$code
  export SMOKE_EXIT=0
  when local
  { [ "$first_code" -ne 0 ] || miss "the first exit: expected non-zero, got $first_code"; } &&
    then_is "the second exit" 0 "$code" &&
    then_is "the image" "$name_:$h" "$out" &&
    then_is "the builds" 2 "$(grep -c '^podman build' "$T/calls")" &&
    then_is "the smokes" 2 "$(grep -c '^smoke' "$T/calls")" &&
    pass
}

# --- promote ---

test_promote_points_main_at_the_commits_tag() {
  name="promote points :main at the commit's tag, keeping its digest"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  echo "$name_:$h $(digest 3)" >>"$T/registry"
  when promote
  then_is "the exit" 0 "$code" &&
    then_has "the calls" "skopeo copy --preserve-digests docker://$name_:$h docker://$name_:main" "$(calls)" &&
    then_is "the ref" "$name_@$(digest 3)" "$(tail -1 <<<"$out")" &&
    pass
}

test_promote_fails_when_the_tag_is_missing() {
  name="promote fails, and moves nothing, when ghcr lacks the commit's tag"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  when promote
  { [ "$code" -ne 0 ] || miss "the exit: expected non-zero, got 0"; } &&
    then_lacks "the calls" "skopeo copy" "$(calls)" &&
    then_has "stderr" "$name_:$h" "$err" &&
    pass
}

# --- local ---

test_local_uses_the_machines_copy() {
  name="local prints the commit's tag and pulls and builds nothing when this machine has it"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  echo "$name_:$h" >>"$T/local"
  when local
  then_is "the exit" 0 "$code" &&
    then_is "the image" "$name_:$h" "$out" &&
    then_lacks "the calls" "podman pull" "$(calls)" &&
    then_lacks "the calls" "podman build" "$(calls)" &&
    pass
}

test_local_pulls_from_ghcr() {
  name="local pulls the commit's tag when ghcr has it, and builds nothing"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  echo "$name_:$h $(digest 4)" >>"$T/registry"
  when local
  then_is "the exit" 0 "$code" &&
    then_is "the image" "$name_:$h" "$out" &&
    then_has "the calls" "podman pull $name_:$h" "$(calls)" &&
    then_lacks "the calls" "podman build" "$(calls)" &&
    pass
}

test_local_builds_when_no_one_has_it() {
  name="local builds and smokes the commit's tag when neither this machine nor ghcr has it, and pushes nothing"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  when local
  then_is "the exit" 0 "$code" &&
    then_is "the image" "$name_:$h" "$out" &&
    then_has "the calls" "podman build -f .devcontainer/Containerfile -t $name_:$h-candidate ." "$(calls)" &&
    then_has "the calls" "smoke $name_:$h-candidate" "$(calls)" &&
    then_has "the calls" "podman tag $name_:$h-candidate $name_:$h" "$(calls)" &&
    then_lacks "the calls" "podman push" "$(calls)" &&
    then_lacks "the calls" "skopeo copy" "$(calls)" &&
    pass
}

test_local_fails_on_a_failed_smoke() {
  name="local fails when the image it built fails its smoke"
  given_repo || fail "setup: the repo"
  export SMOKE_EXIT=1
  when local
  { [ "$code" -ne 0 ] || miss "the exit: expected non-zero, got 0"; } &&
    then_has "the calls" "podman build" "$(calls)" &&
    then_has "the calls" "smoke $name_:$(hash_now)-candidate" "$(calls)" &&
    pass
}

# --- ref ---

test_ref_prefers_the_commits_own_tag() {
  name="ref prints the digest of the commit's tag over :main's"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  printf '%s\n' "$name_:$h $(digest 1)" "$name_:main $(digest 2)" >>"$T/registry"
  when ref
  then_is "the exit" 0 "$code" && then_is "the ref" "$name_@$(digest 1)" "$out" && pass
}

test_ref_falls_back_to_main() {
  name="ref prints :main's digest when the commit's tag is missing"
  given_repo || fail "setup: the repo"
  echo "$name_:main $(digest 2)" >>"$T/registry"
  when ref
  then_is "the exit" 0 "$code" && then_is "the ref" "$name_@$(digest 2)" "$out" && pass
}

test_ref_fails_when_neither_exists() {
  name="ref fails, naming both tags, when neither exists"
  given_repo || fail "setup: the repo"
  h=$(hash_now)
  when ref
  { [ "$code" -ne 0 ] || miss "the exit: expected non-zero, got 0"; } &&
    then_has "stderr" "$name_:$h" "$err" &&
    then_has "stderr" "$name_:main" "$err" &&
    pass
}

# --- usage ---

test_usage_exits_2() {
  name="no command, and an unknown one, exit 2 and say how to use it"
  given_repo || fail "setup: the repo"
  run
  none=$code
  run no-such-command
  then_is "the exit with no command" 2 "$none" &&
    then_is "the exit with an unknown command" 2 "$code" &&
    then_has "stderr" "usage: scripts/dev-image.sh" "$err" &&
    pass
}

# --- a workflow, read as text ---

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
# list_under <key regex>: the `- item` lines of the workflow's block list under the first matching line.
list_under() { wf_lines | list_in "$1"; }
# block <key regex>: the workflow's lines indented under the first matching line.
block() { wf_lines | block_in "$1"; }
# job <name>: the workflow's lines under the job with that name: its own line, and each line indented under it.
job() {
  wf_lines | awk -v j="  $1:" '
    found { if ($0 ~ /^  [^ ]/) exit; print; next }
    $0 == j { found = 1; print }'
}
# present: whether the workflow file the case reads is there, as an assertion's value.
present() { [ -f "$wf" ] && echo present || echo missing; }

# given: the workflow file, dev-image.yml, and the case's own folder for miss's report.
given_workflow() {
  wf=$here/../.github/workflows/${1:-dev-image.yml}
  out='' err=''
  T=$(mktemp -d) || return 1
  : >"$T/calls"
}

test_the_workflow_starts_on_main_and_the_inputs() {
  name="the workflow starts on a push to main that changes an input, and by hand"
  given_workflow || fail "setup: the case's folder"
  want=$( (sed -n 's/^inputs=(\(.*\))$/\1/p' "$here/dev-image.sh" | tr ' ' '\n'
    printf '%s\n' scripts/dev-image.sh scripts/dev-image-smoke.sh .github/workflows/dev-image.yml) | sort)
  then_is "the workflow file" "present" "$(present)" &&
    then_is "on.push.branches" "main" "$(block '^  push:' | sed -n 's/^ *branches: *\[\(.*\)\]$/\1/p')" &&
    then_is "on.push.paths" "$want" "$(list_under '^    paths:' | sort)" &&
    then_has "the triggers" "workflow_dispatch:" "$(block '^on:')" &&
    pass
}

test_only_the_image_job_writes() {
  name="the workflow reads by default, and only its image job may write packages, on main"
  given_workflow || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" &&
    then_is "the top-level permissions" "contents: read" "$(block '^permissions:' | sed 's/^ *//')" &&
    then_is "the image job's permissions" "$(printf '%s\n' 'contents: read' 'packages: write')" \
      "$(block '^    permissions:' | sed 's/^ *//')" &&
    then_has "the image job" "timeout-minutes:" "$(block '^  image:')" &&
    then_has "the image job" "if: github.ref == 'refs/heads/main'" "$(block '^  image:')" &&
    pass
}

test_the_job_logs_in_then_ensures() {
  name="the image job logs in with its own token, then runs ensure"
  given_workflow || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" || return 1
  steps=$(block '^    steps:')
  login=$(grep -n 'podman login ghcr.io' <<<"$steps" | cut -d: -f1)
  ensure=$(grep -n 'run: scripts/dev-image.sh ensure$' <<<"$steps" | cut -d: -f1)
  # shellcheck disable=SC2016 # The expression is GitHub's, read as text.
  then_has "the steps" 'TOKEN: ${{ secrets.GITHUB_TOKEN }}' "$steps" &&
    then_has "the steps" "printf '%s' \"\$TOKEN\" | podman login ghcr.io --username \"\${{ github.actor }}\" --password-stdin" "$steps" &&
    { [ -n "$login" ] && [ -n "$ensure" ] && [ "$login" -lt "$ensure" ] ||
      miss "the steps: expected the login before ensure; got lines [$login] [$ensure]"; } &&
    pass
}

test_each_action_is_pinned() {
  name="each action the workflow uses is pinned to a full commit hash"
  given_workflow || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" || return 1
  uses=$(wf_lines | grep -E '^\s*-?\s*uses:')
  bad=$(grep -vE 'uses: [^@ ]+@[0-9a-f]{40}( |$)' <<<"$uses" || true)
  then_is "the unpinned uses" "" "$bad" &&
    { [ -n "$uses" ] || miss "the workflow: expected it to use an action, got none"; } &&
    pass
}

# --- checks.yml: the check runs in the dev image ---

# the lines of the checks job's gate step: its env, and its run block.
gate_step() { job checks | block_in '^      - env:'; }
# gate_script: the gate's run block as the shell it is, one command per line, no indentation.
gate_script() { gate_step | sed -n '/^ *run: |/,$p' | tail -n +2 | sed 's/^ *//'; }
# gate_exit <image result> <check result>: the gate's exit when the two jobs ended so.
gate_exit() {
  IMAGE=$1 CHECK=$2 sh -ec "$(gate_script)" >/dev/null 2>&1
  echo $?
}

test_the_image_job_resolves_the_dev_image() {
  name="the image job reads its token, logs in with it, and writes dev-image.sh ref's output as its image"
  given_workflow checks.yml || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" || return 1
  image=$(job image)
  steps=$(block_in '^    steps:' <<<"$image")
  login=$(grep -F 'skopeo login ghcr.io' <<<"$steps" || true)
  ref=$(block_in '^      - id: image' <<<"$steps")
  ref_write=$(grep -F '>> "$GITHUB_OUTPUT"' <<<"$ref" || true)
  login_at=$(grep -nF 'skopeo login ghcr.io' <<<"$steps" | cut -d: -f1)
  ref_at=$(grep -nF 'id: image' <<<"$steps" | cut -d: -f1)
  then_is "the image job's permissions" "$(printf '%s\n' 'contents: read' 'packages: read')" \
    "$(block_in '^    permissions:' <<<"$image" | sed 's/^ *//' | sort)" &&
    then_has "the login step's env" 'TOKEN: ${{ secrets.GITHUB_TOKEN }}' "$steps" &&
    # The left side of the pipe is the variable the env line sets: a login that pipes anything else gets a bad
    # password, and the image job fails where this case would have said it was right.
    then_has "the login's pipe" 'printf '\''%s'\'' "$TOKEN" | skopeo login' "$login" &&
    then_has "the login" '| skopeo login ghcr.io --username "${{ github.actor }}" --password-stdin' "$login" &&
    then_lacks "the login" '--password ' "$login" &&
    { [ -n "$login_at" ] && [ -n "$ref_at" ] && [ "$login_at" -lt "$ref_at" ] ||
      miss "the steps: expected the login before the id: image step; got lines [$login_at] [$ref_at]"; } &&
    then_has "the ref step" 'scripts/dev-image.sh ref' "$ref" &&
    then_has "the ref step's write" 'image=' "$ref_write" &&
    then_is "the image job's output" 'image: ${{ steps.image.outputs.image }}' \
      "$(block_in '^    outputs:' <<<"$image" | sed 's/^ *//')" &&
    pass
}

test_the_check_job_runs_in_that_image() {
  name="the check job needs the image job, runs in its image with its token, prints it, then runs check.sh"
  given_workflow checks.yml || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" || return 1
  check_job=$(job check)
  needs=$(grep -E '^    needs:' <<<"$check_job" || true)
  container=$(block_in '^    container:' <<<"$check_job")
  steps=$(block_in '^    steps:' <<<"$check_job")
  first=$(head -1 <<<"$steps")
  echo_at=$(grep -nF 'dev image:' <<<"$steps" | cut -d: -f1)
  check_at=$(grep -nF 'scripts/check.sh' <<<"$steps" | cut -d: -f1)
  then_has "the check job's needs" 'image' "$needs" &&
    then_is "the check job's permissions" "$(printf '%s\n' 'contents: read' 'packages: read')" \
      "$(block_in '^    permissions:' <<<"$check_job" | sed 's/^ *//' | sort)" &&
    then_has "the container's image" 'image: ${{ needs.image.outputs.image }}' "$container" &&
    then_has "the container's credentials" 'username: ${{ github.actor }}' "$container" &&
    then_has "the container's credentials" 'password: ${{ secrets.GITHUB_TOKEN }}' "$container" &&
    then_has "the first step" 'echo "dev image: ${{ needs.image.outputs.image }}"' "$first" &&
    { [ -n "$echo_at" ] && [ -n "$check_at" ] && [ "$echo_at" -lt "$check_at" ] ||
      miss "the steps: expected the image echo, then scripts/check.sh; got lines [$echo_at] [$check_at]"; } &&
    pass
}

# A job container runs as root: root reads every file, so a check that needs a file it may not open cannot fail as
# it should, and git refuses a checkout root does not own. The check runs as the image's node, as in the dev
# container, over a checkout node owns.
test_the_check_runs_as_node_over_a_checkout_node_owns() {
  name="the check job hands the checkout to node and runs check.sh as node, with node's home"
  given_workflow checks.yml || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" || return 1
  steps=$(job check | block_in '^    steps:')
  checkout_at=$(grep -nF 'uses: actions/checkout@' <<<"$steps" | cut -d: -f1)
  chown_at=$(grep -nF 'chown -R node:node' <<<"$steps" | cut -d: -f1)
  then_has "the check step" 'run: chown -R node:node "$GITHUB_WORKSPACE" && runuser -u node -- env HOME=/home/node scripts/check.sh' "$steps" &&
    then_lacks "the steps" 'run: scripts/check.sh' "$steps" &&
    # A chown before the checkout hands over nothing: the checkout lands after it, root-owned, and node's git
    # refuses it as dubious ownership.
    { [ -n "$checkout_at" ] && [ -n "$chown_at" ] && [ "$checkout_at" -lt "$chown_at" ] ||
      miss "the steps: expected the checkout before the chown; got lines [$checkout_at] [$chown_at]"; } &&
    pass
}

test_no_toolchain_is_set_up() {
  name="no line of checks.yml names actions/setup-node or node's cache; the image holds them"
  given_workflow checks.yml || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" &&
    then_has "the workflow" 'uses: actions/checkout@' "$(wf_lines)" &&
    then_lacks "the workflow" 'actions/setup-node' "$(wf_lines)" &&
    then_lacks "the workflow" 'node-version' "$(wf_lines)" &&
    then_lacks "the workflow" 'cache: npm' "$(wf_lines)" &&
    pass
}

test_the_required_job_cannot_pass_on_a_skip() {
  name="checks always runs, needs both jobs, and exits non-zero unless both results are success"
  given_workflow checks.yml || fail "setup: the case's folder"
  then_is "the workflow file" "present" "$(present)" || return 1
  checks_job=$(job checks)
  needs=$(grep -E '^    needs:' <<<"$checks_job" || true)
  gate=$(gate_step)
  then_has "the checks job" 'if: always()' "$checks_job" &&
    then_has "the checks job's needs" 'image' "$needs" &&
    then_has "the checks job's needs" 'check' "$needs" &&
    then_has "the gate's env" 'IMAGE: ${{ needs.image.result }}' "$gate" &&
    then_has "the gate's env" 'CHECK: ${{ needs.check.result }}' "$gate" &&
    then_is "the gate on success and success" 0 "$(gate_exit success success)" &&
    { [ "$(gate_exit failure success)" -ne 0 ] || miss "the gate: expected non-zero when the image job failed, got 0"; } &&
    { [ "$(gate_exit success failure)" -ne 0 ] || miss "the gate: expected non-zero when the check job failed, got 0"; } &&
    { [ "$(gate_exit failure failure)" -ne 0 ] || miss "the gate: expected non-zero when both failed, got 0"; } &&
    pass
}

# Each case in its own subshell, so its exports and its folder stay its own.
failed=0
for t in $(declare -F | awk '$3 ~ /^test_/ {print $3}'); do
  ("$t"; rc=$?; [ -z "${T:-}" ] || rm -rf "$T"; exit "$rc") || failed=1
done
exit "$failed"
