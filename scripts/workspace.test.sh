#!/usr/bin/env bash
# shellcheck disable=SC2329 # A case is called by name, by the loop at the end.
# shellcheck disable=SC2312 # An assertion reads a command's output; its exit is the assertion's, not the command's.
# The tests of scripts/workspace.sh, with real rootless podman, on the host: never in a CI job container.
# Each case makes workspace roots under a temp folder, each a folder with a .devcontainer/devcontainer.json
# and, where it has services, a pod.yaml. Their repo is `wstest`, so every network, pod and volume a case
# makes starts with `wstest-`. The router is this run's own (WORKSPACE_ROUTER, its port and its state), so a
# person's router is never touched. Every container a case starts is capped. Each case removes what it made.
# Run it from anywhere: scripts/workspace.test.sh. One ok or not ok line per case, exit 1 if any fails.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
script=$here/workspace.sh
pg=docker.io/library/postgres:17
caddy=docker.io/library/caddy:2.10
cap=(--cpus=3 --cpu-shares=256)

T=$(mktemp -d)
export WORKSPACE_ROUTER=wstest-router WORKSPACE_ROUTER_PORT=18091 WORKSPACE_ROUTER_STATE=$T/router

# given: a workspace root named <folder>, with a devcontainer.json, and a pod.yaml when $2 is "db".
# $3, when set, is the app port the file forwards.
given_root() {
  local root=$T/$1
  mkdir -p "$root/.devcontainer"
  {
    echo '// a test workspace'
    echo '{'
    echo '  "name": "wstest",'
    [ -z "${3:-}" ] || echo "  \"forwardPorts\": [$3],"
    echo '  "image": "unused"'
    echo '}'
  } >"$root/.devcontainer/devcontainer.json"
  if [ "${2:-}" = db ]; then
    cat >"$root/.devcontainer/pod.yaml" <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: WORKSPACE
spec:
  restartPolicy: Never
  containers:
    - name: postgres
      image: $pg
      env:
        - {name: POSTGRES_PASSWORD, value: test}
      resources:
        limits:
          cpu: "3"
      volumeMounts:
        - {name: WORKSPACE-pgdata, mountPath: /var/lib/postgresql/data}
  volumes:
    - name: WORKSPACE-pgdata
      emptyDir: {}
YAML
  fi
  echo "$root"
}

# a one-off container on network $1 that runs $2 with bash, capped.
on_net() { podman run --rm "${cap[@]}" --network "$1" --entrypoint bash "$pg" -c "$2"; }

# waits until the workspace's postgres answers on its network, up to 30 s.
wait_pg() {
  for _ in $(seq 30); do
    on_net "$1" 'pg_isready -q -h postgres' 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

leftovers() {
  {
    podman network ls --format '{{.Name}}' | grep '^wstest-' | grep -v "^$WORKSPACE_ROUTER$"
    podman pod ls --format '{{.Name}}' | grep '^wstest-'
    podman volume ls --format '{{.Name}}' | grep '^wstest-'
    podman ps -a --format '{{.Names}}' | grep '^wstest-' | grep -v "^$WORKSPACE_ROUTER$"
  } 2>/dev/null
}

test_the_name_is_the_repo_and_the_folder() {
  local r
  r=$(given_root one)
  [ "$("$script" name "$r")" = wstest-one ]
}

test_a_folder_that_is_no_dns_label_is_refused() {
  local r
  r=$(given_root Bad_Name)
  ! "$script" up "$r" 2>/dev/null && ! podman network exists wstest-Bad_Name
}

test_two_workspaces_each_reach_their_own_database_and_not_the_other() {
  local a b ip ok=0
  a=$(given_root a db) && b=$(given_root b db)
  "$script" up "$a" >/dev/null && "$script" up "$b" >/dev/null &&
    wait_pg wstest-a && wait_pg wstest-b &&
    ip=$(podman inspect wstest-b-postgres --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}') &&
    [ -n "$ip" ] &&
    ! on_net wstest-a "timeout 3 bash -c '</dev/tcp/$ip/5432'" 2>/dev/null &&
    ! on_net wstest-a 'getent hosts wstest-b' >/dev/null 2>&1 &&
    [ "$(podman network inspect wstest-a --format '{{index .Options "isolate"}}')" = strict ] || ok=1
  "$script" down "$a" >/dev/null
  "$script" down "$b" >/dev/null
  return "$ok"
}

test_an_attempt_reaches_its_database_and_not_the_internet() {
  local a ok=0
  a=$(given_root attempt db)
  "$script" up --attempt "$a" >/dev/null && wait_pg wstest-attempt &&
    [ "$(podman network inspect wstest-attempt --format '{{.Internal}}')" = true ] &&
    ! on_net wstest-attempt 'getent hosts registry.npmjs.org' >/dev/null 2>&1 &&
    ! on_net wstest-attempt "timeout 3 bash -c '</dev/tcp/1.1.1.1/443'" 2>/dev/null || ok=1
  "$script" down "$a" >/dev/null
  return "$ok"
}

test_a_pod_made_again_is_reached_with_no_restart() {
  local a ok=0
  a=$(given_root again db)
  "$script" up "$a" >/dev/null && wait_pg wstest-again &&
    podman run -d --name wstest-again-dev "${cap[@]}" --network wstest-again --entrypoint sleep "$pg" 600 >/dev/null &&
    podman pod rm -f wstest-again >/dev/null && "$script" up "$a" >/dev/null && wait_pg wstest-again &&
    podman exec wstest-again-dev pg_isready -q -h postgres || ok=1
  podman rm -f -t 0 wstest-again-dev >/dev/null 2>&1
  "$script" down "$a" >/dev/null
  return "$ok"
}

test_the_router_serves_each_workspace_at_its_name() {
  local a b ok=0 port=$WORKSPACE_ROUTER_PORT
  a=$(given_root ra '' 3000) && b=$(given_root rb '' 3000)
  "$script" up "$a" >/dev/null && "$script" up "$b" >/dev/null &&
    podman run -d --name wstest-ra-dev "${cap[@]}" --network wstest-ra --network-alias wstest-ra-app "$caddy" caddy respond --listen :3000 'workspace A' >/dev/null &&
    podman run -d --name wstest-rb-dev "${cap[@]}" --network wstest-rb --network-alias wstest-rb-app "$caddy" caddy respond --listen :3000 'workspace B' >/dev/null &&
    sleep 1 &&
    [ "$(curl -s --max-time 5 -H 'Host: wstest-ra.localhost' "http://127.0.0.1:$port/")" = 'workspace A' ] &&
    [ "$(curl -s --max-time 5 -H 'Host: wstest-rb.localhost' "http://127.0.0.1:$port/")" = 'workspace B' ] &&
    [ "$("$script" url "$a")" = "http://wstest-ra.localhost:$port" ] || ok=1
  podman rm -f -t 0 wstest-ra-dev wstest-rb-dev >/dev/null 2>&1
  "$script" down "$a" >/dev/null
  # a's route is gone with it, and b's still serves
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: wstest-ra.localhost' "http://127.0.0.1:$port/")" = 404 ] || ok=1
  "$script" down "$b" >/dev/null
  return "$ok"
}

test_an_attempt_gets_no_route() {
  local a ok=0
  a=$(given_root rattempt '' 3000)
  "$script" up --attempt "$a" >/dev/null &&
    [ ! -e "$WORKSPACE_ROUTER_STATE/routes/wstest-rattempt.caddy" ] &&
    ! podman inspect "$WORKSPACE_ROUTER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | grep -qw wstest-rattempt || ok=1
  "$script" down "$a" >/dev/null
  return "$ok"
}

test_up_twice_changes_nothing() {
  local a pod ok=0
  a=$(given_root twice db)
  "$script" up "$a" >/dev/null && pod=$(podman pod inspect wstest-twice --format '{{.Id}}') &&
    "$script" up "$a" >/dev/null &&
    [ "$(podman pod inspect wstest-twice --format '{{.Id}}')" = "$pod" ] || ok=1
  "$script" down "$a" >/dev/null
  return "$ok"
}

test_down_leaves_nothing() {
  [ -z "$(leftovers)" ]
}

TESTS=(
  test_the_name_is_the_repo_and_the_folder
  test_a_folder_that_is_no_dns_label_is_refused
  test_two_workspaces_each_reach_their_own_database_and_not_the_other
  test_an_attempt_reaches_its_database_and_not_the_internet
  test_a_pod_made_again_is_reached_with_no_restart
  test_the_router_serves_each_workspace_at_its_name
  test_an_attempt_gets_no_route
  test_up_twice_changes_nothing
  test_down_leaves_nothing
)

cleanup() {
  podman rm -f -t 0 "$WORKSPACE_ROUTER" >/dev/null 2>&1
  podman network rm "$WORKSPACE_ROUTER" >/dev/null 2>&1
  podman unshare rm -rf "$T" 2>/dev/null || rm -rf "$T"
}
trap cleanup EXIT

failed=0
for t in "${TESTS[@]}"; do
  if "$t"; then echo "ok $t"; else echo "not ok $t"; failed=1; fi
done
exit $failed
