#!/usr/bin/env bash
# The profile-guided build (docs/pgo_design.md): `garnet --pgo-train` writes
# default.pgo next to the entry file and the program prints what the plain
# build prints; a later plain build applies the profile and says so; --pgo off
# ignores it; the unit cache keys its objects by the profile's content; a
# training run that writes no profile fails loudly and leaves no instrumented
# executable behind.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
fail=0
ok() { echo "[pgo] PASS $1"; }
bad() { echo "[pgo] FAIL $1"; fail=1; }
. "$ROOT/scripts/lib/pgo.sh"
if ! tsaot_pgo_supported "${TSAOT_CC:-cc -O2}" || ! tsaot_pgo_profdata > /dev/null 2>&1; then
  echo "[pgo] SKIP (clang and llvm-profdata are needed)"; exit 0
fi
export TSAOT_UNITS_CACHE="$W/cache"
P="$W/prog"; mkdir -p "$P"
cat > "$P/work.ts" <<'TS'
class Acc { total = 0; odd = 0; add(n: number): void { if (n % 2 === 1) this.odd++; this.total += n; } }
function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
function main(): void {
  const acc = new Acc();
  const words: string[] = [];
  for (let i = 0; i < 20000; i++) { acc.add(i % 7); if (i % 1000 === 0) words.push("w" + i); }
  const built = new RegExp("w(" + "\\d+)");   // a pattern built at run time: the training run records it
  console.log(acc.total, acc.odd, fib(20), words.join(","), /w(\d+)/.exec(words[3])![1], built.exec(words[2])![1]);
}
main();
TS
build() { # name [driver flags...]: builds into $W/<name>/work, stderr in $W/<name>.err
  local n="$1"; shift
  mkdir -p "$W/$n"
  "$ROOT/garnet" "$@" -o "$W/$n/work.c" "$P/work.ts" > /dev/null 2> "$W/$n.err"
}
expect_output() { # name
  local out; out="$("$W/$1/work" 2>&1)"
  if [[ -n "$out" && "$out" == "$want" ]]; then ok "$1: the output of the plain build"; else bad "$1: [$out] vs [$want]"; fi
}
build plain || { bad "the plain build"; head -5 "$W/plain.err"; exit 1; }
want="$("$W/plain/work" 2>&1)"
grep -q "profile-guided" "$W/plain.err" && bad "the plain build claims a profile" || ok "the plain build applies no profile"
# training writes default.pgo next to the entry file and applies it
if build pgo --pgo-train '"$TSAOT_PGO_BIN" > /dev/null'; then
  [[ -f "$P/default.pgo" ]] && ok "default.pgo written next to the entry file" || bad "no $P/default.pgo"
  grep -q "profile-guided: $P/default.pgo" "$W/pgo.err" && ok "the trained build applies the profile" || { bad "the trained build does not say it applies the profile"; tail -3 "$W/pgo.err"; }
  expect_output pgo
  # the run-time regexp: recorded, compiled to a matcher, bound by content (docs/regexp_vm_design.md)
  if [[ -f "$P/default.regexps" ]] && grep -q "00770028005c0064002b0029" "$P/default.regexps"; then ok "default.regexps holds the pattern built at run time"; else bad "default.regexps: $(cat "$P/default.regexps" 2>&1 | head -3)"; fi
  grep -q "regexps: $P/default.regexps" "$W/pgo.err" && ok "the trained build applies the regexps" || bad "the trained build does not say it applies the regexps"
  if TSAOT_REGEXP_TRACE=1 "$W/pgo/work" 2>&1 >/dev/null | grep -q 'native table: bound'; then ok "the run-time pattern binds its native matcher"; else bad "no table binding reported"; fi
  if build rxoff --regexps off && ! grep -q "regexps:" "$W/rxoff.err" && ! (TSAOT_REGEXP_TRACE=1 "$W/rxoff/work" 2>&1 >/dev/null | grep -q 'native table'); then ok "--regexps off leaves the pattern on the interpreter"; else bad "--regexps off"; fi
  expect_output rxoff
else bad "--pgo-train"; head -5 "$W/pgo.err"; fi
# a later plain build picks it up; --pgo off ignores it
build auto && grep -q "profile-guided: $P/default.pgo" "$W/auto.err" && ok "a later build applies default.pgo" || bad "a later build does not apply default.pgo"
expect_output auto
build off --pgo off && ! grep -q "profile-guided\|regexps:" "$W/off.err" && ok "--pgo off ignores it (and the regexps)" || bad "--pgo off"
# units: the cache keys objects by the profile's content
if build u1 --units --pgo-train '"$TSAOT_PGO_BIN" > /dev/null; "$TSAOT_PGO_BIN" > /dev/null'; then
  expect_output u1
  n1=$(ls "$W"/cache/*.o | wc -l | tr -d ' ')
  build u2 --units; n2=$(ls "$W"/cache/*.o | wc -l | tr -d ' ')
  [[ "$n2" == "$n1" ]] && ok "the same profile hits the unit cache" || bad "the same profile recompiled ($n1 -> $n2 objects)"
  build u3 --units --pgo-train '"$TSAOT_PGO_BIN" > /dev/null'; n3=$(ls "$W"/cache/*.o | wc -l | tr -d ' ')
  [[ "$n3" -gt "$n2" ]] && ok "a changed profile recompiles the units" || bad "a changed profile hit the cache ($n2 -> $n3 objects)"
  expect_output u3
else bad "--units --pgo-train"; head -5 "$W/u1.err"; fi
# a training run that never runs the program
if build f --pgo-train 'true'; then bad "a training run without a profile succeeded"; else
  grep -q "no profile" "$W/f.err" && ok "a training run without a profile fails loudly" || { bad "the failure's message"; tail -3 "$W/f.err"; }
  [[ -e "$W/f/work.pgo-gen" ]] && bad "the instrumented executable was left behind" || ok "no instrumented executable left behind"
fi
[[ $fail -eq 0 ]] && echo "[pgo] PASS" || { echo "[pgo] FAIL"; exit 1; }
