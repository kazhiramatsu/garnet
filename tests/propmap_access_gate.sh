#!/usr/bin/env bash
# The common object prefix's property map is read through obj_map (any
# object) and obj_map_plain (an object whose map is in place), never by its
# fields: a sized instance keeps its map behind a pointer
# (docs/cell_header_design.md, H2). This gate compiles a copy of the runtime
# with the in-place fields and `map` renamed; the only accesses the compiler
# may then reject are the accessors' own.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CC_CHECK="${TSAOT_GATE_CC:-cc}"
work="$(mktemp -d "${TMPDIR:-/tmp}/garnet-propmap.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cp -R "$ROOT/runtime/." "$work/"
python3 - "$work/ts_rt.h" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
old = "    ts_propmap map;\n    struct { ts_prop* props; uint32_t cap, len; uint32_t* prop_index; };"
new = "    ts_propmap map__gate;\n    struct { ts_prop* props__gate; uint32_t cap__gate, len__gate; uint32_t* prop_index__gate; };"
if s.count(old) != 1:
    sys.exit("[propmap] FAIL: the common prefix's map union changed; update tests/propmap_access_gate.sh")
s = s.replace(old, new)
open(p, "w").write(s)
PY
fail=0
for defs in "" "-DTSAOT_RT_STATS"; do
  if "$CC_CHECK" -fsyntax-only -ferror-limit=0 -DTSAOT_ENABLE_FETCH=1 $defs -I"$work" "$work/ts_rt.c" > "$work/out.txt" 2>&1; then
    echo "[propmap] FAIL: the renamed copy compiled; the accessors no longer read the map" >&2; exit 1
  fi
  # every rejected access must be inside the two accessors
  python3 - "$work/out.txt" "$work" <<'PY' || fail=1
import re, sys
out, work = sys.argv[1], sys.argv[2]
bad = []
defre = re.compile(r"^[A-Za-z_][^;]*\(")
def enclosing(lines, ln):
    for i in range(ln - 1, -1, -1):
        l = lines[i]
        if defre.match(l) and not re.match(r"^(typedef|enum|struct|union|#)", l):
            name = re.sub(r"\(.*", "", l)
            return re.sub(r".*[^A-Za-z0-9_]", "", name)
    return "?"
for line in open(out):
    m = re.match(r"(\S+?):(\d+):\d+: error: (.*)", line)
    if not m: continue
    path, ln, msg = m.group(1), int(m.group(2)), m.group(3)
    lines = open(path if path.startswith("/") else work + "/" + path.lstrip("./")).read().split("\n")
    if enclosing(lines, ln) in ("obj_map", "obj_map_plain"): continue
    bad.append(f"{path.split('/')[-1]}:{ln}: {msg}: {lines[ln - 1].strip()}")
for b in bad: print("[propmap] FAIL:", b)
sys.exit(1 if bad else 0)
PY
done
[ "$fail" = 0 ] || exit 1
echo "[propmap] PASS: the property map is read only through obj_map and obj_map_plain"
