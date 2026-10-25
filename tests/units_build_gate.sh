#!/usr/bin/env bash
# The unit build (docs/build_split_design.md): programs built with
# `./garnet --units` print what their one-file builds print. Small thresholds
# make every kind of unit occur (module chunks, bins, cold units, inline
# copies, unit-local statics); a rebuild compiles nothing, and an edit of one
# module's function recompiles only the units that contain its text.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
fail=0
ok() { echo "[units] PASS $1"; }
bad() { echo "[units] FAIL $1"; fail=1; }
export TSAOT_UNIT_CHUNK_LINES=300 TSAOT_UNIT_BINS=3 TSAOT_UNIT_COLD_LINES=400 TSAOT_UNITS_CACHE="$W/cache"

# a program of four modules
P="$W/mm"; mkdir -p "$P"
cat > "$P/entry.ts" <<'EOF'
import { twice, Counter } from "./a";
import { label } from "./b";
import { table } from "./c";
const c = new Counter();
for (let i = 0; i < 5; i++) c.add(twice(i));
console.log(label(c.total), table(3).join(","));
EOF
cat > "$P/a.ts" <<'EOF'
export function twice(x: number): number { return x * 2; }
export class Counter { total = 0; add(n: number) { this.total += n; } }
EOF
cat > "$P/b.ts" <<'EOF'
import { twice } from "./a";
export function label(n: number): string { return "total=" + twice(n) / 2; }
EOF
cat > "$P/c.ts" <<'EOF'
export function table(n: number): number[] { const out: number[] = []; for (let i = 0; i < n; i++) out.push(i * 7 + 1); return out; }
EOF

# same output as the one-file build
check() { # name input [driver flags...]
  local n="$1" in="$2"; shift 2
  mkdir -p "$W/$n"
  "$ROOT/garnet" "$in" -o "$W/$n/one.c" > /dev/null 2> "$W/$n/one.err" || { bad "$n: the one-file build"; head -3 "$W/$n/one.err"; return; }
  "$ROOT/garnet" --units "$@" "$in" -o "$W/$n/split.c" > /dev/null 2> "$W/$n/split.err" || { bad "$n: the unit build"; head -5 "$W/$n/split.err"; return; }
  local a b; a="$("$W/$n/one" 2>&1)"; b="$("$W/$n/split" 2>&1)"
  if [[ -n "$a" && "$a" == "$b" ]]; then ok "$n: the output of the one-file build"; else bad "$n: [$b] vs [$a]"; fi
}
check modules "$P/entry.ts"
check modules_nolto "$P/entry.ts" --no-lto
# a module initialization large enough to be split into chunks
# (docs/startup_design.md, S1): top-level loops, a labeled loop, if/else,
# a switch, a class, a closure over top-level variables; and one with a
# top-level try/catch, which keeps it whole (its handler's setjmp)
I="$W/init"; mkdir -p "$I"
{
  echo 'const table: number[] = [];'
  echo 'for (let i = 0; i < 40; i++) table.push((i * 3) % 7);'
  echo 'let total = 0; let s = "";'
  echo 'outer: for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) { if (j === 3) continue outer; total += i * j; } }'
  echo 'class Point { constructor(public x: number, public y: number) {} norm(): number { return Math.hypot(this.x, this.y); } }'
  echo 'const p = new Point(3, 4);'
  echo 'function lazy(): number { return total + table.length; }'
  for k in $(seq 1 40); do
    echo "const v$k = table[$k % table.length] + $k; total += v$k * 2;"
    echo "if (v$k % 2) { s += \"o\"; } else { s += \"e\"; }"
    echo "switch (v$k % 3) { case 0: total += 1; break; case 1: s += \"$k\"; break; default: total -= 1; }"
  done
  echo 'console.log(total, s.length, s.slice(0, 20), p.norm(), lazy());'
} > "$I/init.ts"
TSAOT_UNIT_INIT_CHUNK_LINES=40 check init_split "$I/init.ts"
{ cat "$I/init.ts"; echo 'try { JSON.parse("{bad"); } catch (e) { console.log("caught"); }'; } > "$I/init_try.ts"
TSAOT_UNIT_INIT_CHUNK_LINES=40 check init_whole "$I/init_try.ts"
if ls "$W"/init_split/split.units/init_*.c > /dev/null 2>&1 && [[ $(ls "$W"/init_split/split.units/init_*.c | wc -l) -ge 1 ]] &&
   grep -qs "__part_1(mi__s, " "$W"/init_split/split.units/init_*_0.c; then
  ok "the module initialization split into chunks"
else
  bad "the module initialization was not split"
fi
if ls "$W"/init_whole/split.units/cold_*module_init*.c > /dev/null 2>&1 && ! ls "$W"/init_whole/split.units/init_*.c > /dev/null 2>&1; then
  ok "a top-level try/catch keeps it whole"
else
  bad "the module initialization with a try/catch was split"
fi
for t in exhaustive/objects/static_slots exhaustive/gc/sized_sidecar_props exhaustive/maps_sets/weak_collections; do
  check "$(basename "$t")" "$ROOT/tests/conformance/$t.ts"
done
# every kind of unit occurred
all="$(ls "$W"/*/split.units/*.c 2>/dev/null | xargs -n 1 basename | sort -u)"
for k in data.c 'bin_' 'm_' 'cold_' 'init_'; do
  grep -q "^$k" <<< "$all" && ok "a unit of kind $k" || bad "no unit of kind $k"
done
grep -qs "static inline tsv fn_" "$W"/*/split.units/*.c && ok "inline copies" || bad "no inline copies"
grep -qsE "^static [a-z ]+ fn_[0-9][^;]*\{" "$W"/*/split.units/*.c && ok "unit-local static functions" || bad "no unit-local static function"
# hidden visibility for what the program defines (Mach-O: nm -m)
if nm -m "$W/modules_nolto/split.units/data.o" > /dev/null 2>&1; then
  if nm -m "$W"/modules_nolto/split.units/*.o | grep -E "\(__(TEXT|DATA)," | grep -v "private external" | grep -qE " external _(fn_|CLASS_)"; then
    bad "a program symbol is not hidden"
  else
    ok "program symbols are hidden"
  fi
fi

# module paths do not depend on where the project is: a relative entry (as
# the native build scripts give it) in two copies of the project
mkdir -p "$W/elsewhere/deeper" && cp -R "$P" "$W/elsewhere/deeper/copy"
mods() { (cd "$1" && node "$ROOT/exporter/exporter.js" entry.ts "$W/ir.json" "$W/labels.json" > /dev/null 2>&1) &&
  node -e 'console.log(JSON.stringify(require(process.argv[1]).modules))' "$W/ir.json"; }
m1="$(mods "$P")"; m2="$(mods "$W/elsewhere/deeper/copy")"
if [[ "$m1" == '["a.ts","b.ts","c.ts","entry.ts"]' && "$m1" == "$m2" ]]; then
  ok "module paths relative to the project"
else
  bad "module paths: $m1 and $m2"
fi

# the object cache: a rebuild compiles nothing; an edit of c.ts's function
# recompiles its units (its own, and its callers' copies), not every unit
count() { find "$W/cache" -maxdepth 1 -name '*.o' | wc -l | tr -d ' '; }
n0="$(count)"
"$ROOT/garnet" --units "$P/entry.ts" -o "$W/modules/split.c" > /dev/null 2>&1 || bad "the rebuild"
n1="$(count)"
[[ "$n1" == "$n0" ]] && ok "a rebuild compiles nothing" || bad "a rebuild compiled $((n1 - n0)) units"
units="$(ls "$W/modules/split.units"/*.c | wc -l | tr -d ' ')"
sed -i.bak 's/i \* 7 + 1/i * 7 + 2/' "$P/c.ts"
"$ROOT/garnet" --units "$P/entry.ts" -o "$W/modules/split.c" > /dev/null 2>&1 || bad "the build after the edit"
n2="$(count)"
out="$("$W/modules/split" 2>&1)"
if [[ "$out" == "total=20 2,9,16" && $((n2 - n1)) -ge 1 && $((n2 - n1)) -lt "$units" ]]; then
  ok "an edit recompiles $((n2 - n1)) of $units units"
else
  bad "after the edit: [$out], $((n2 - n1)) of $units units recompiled"
fi
# the cache key covers what the header includes: a macro changed in an
# included header recompiles the units that use it
U="$W/inc"; mkdir -p "$U/units" "$U/include"
printf '#include <stdio.h>\n#include "dep.h"\nint value(void);\n' > "$U/units/prog.h"
printf '#include "prog.h"\nint value(void) { return VALUE; }\n' > "$U/units/bin_0.c"
printf '#include "prog.h"\nint main(void) { printf("%%d\\n", value()); return 0; }\n' > "$U/units/data.c"
inc_build() {
  echo "#define VALUE $1" > "$U/include/dep.h"
  ( . "$ROOT/scripts/lib/units.sh" && TSAOT_UNITS_CFLAGS="-I$U/include" tsaot_units_build "$U/units" "$U/prog" ) > /dev/null 2>&1 &&
    "$U/prog"
}
v1="$(inc_build 1)"; v2="$(inc_build 2)"
[[ "$v1" == 1 && "$v2" == 2 ]] && ok "an included header's change recompiles" || bad "an included header's change: [$v1] then [$v2]"
[[ $fail -eq 0 ]] && echo "[units] all checks passed" || { echo "[units] FAILURES"; exit 1; }
