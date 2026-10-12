#!/bin/sh
# Live smoke test of the read-only CLI surface against a running shell:
# every `get` resource in every -o format, describe, the help pages, the
# hidden legacy groups, and completion. Mutating verbs are NOT run here.
#
#   sh test/smoke.sh [path/to/aura.cjs]      (default: dist/aura.cjs)
set -u
AURA="node ${1:-dist/aura.cjs}"
pass=0; fail=0
check() {
  desc="$1"; shift
  if out=$("$@" 2>&1); then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc"; echo "$out" | head -5 | sed 's/^/    /'; fi
}
for r in apps inst sc act caps svc mounts ports scopes themes perms; do
  for o in table wide json yaml name; do check "get $r -o $o" $AURA get $r -o $o; done
done
INST=$($AURA get inst -o name | head -1 | cut -d/ -f2)
APP=$($AURA get apps -o name | head -1 | cut -d/ -f2)
check "get inst <id> sidecars"     $AURA get inst "$INST" sidecars
check "describe app"               $AURA describe app "$APP"
check "describe inst"              $AURA describe inst "$INST"
check "describe inst -o json"      $AURA describe inst "$INST" -o json
check "api-resources"              $AURA api-resources
check "help"                       $AURA --help
for v in get describe stop start restart kill pause resume delete install enable disable open exec logs grant revoke set run jump info; do
  check "$v --help" $AURA $v --help
done
check "legacy app list"            $AURA app list
check "legacy inst ls"             $AURA inst ls
check "legacy activity ls"         $AURA activity ls
check "legacy service ls"          $AURA service ls
check "legacy theme list"          $AURA theme list
check "legacy scope list"          $AURA scope list
check "legacy whereami --json"     $AURA whereami --json
check "legacy sdk install --help"  $AURA sdk install --help
check "ps"                         $AURA ps
check "info --json"                $AURA info --json
check "status"                     $AURA status
check "mount ls --help"            $AURA mount ls --help
check "completion bash"            $AURA completion bash
check "__complete get inst"        $AURA __complete get inst
check "get sidecars"               $AURA get sidecars
check "get perms"                  $AURA get perms
for v in "start app" "start inst" "restart inst" "restart svc" "open inst" "logs svc" "rm mount" "rm port" "install cap"; do
  check "$v --help" $AURA $v --help
done
# Expected failures must fail.
if $AURA get nosuch >/dev/null 2>&1; then fail=$((fail+1)); echo "FAIL: get nosuch should exit non-zero"; else pass=$((pass+1)); fi
if $AURA stop sc x >/dev/null 2>&1; then fail=$((fail+1)); echo "FAIL: stop sc should exit non-zero"; else pass=$((pass+1)); fi
echo "smoke: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
