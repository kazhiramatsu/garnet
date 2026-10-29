#!/bin/bash
set -e
cd "$(dirname "$0")/.."
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d)
fail=0
# unsupported array method (Array.from/copyWithin/reduceRight and the ES2023
# change-by-copy methods toSorted/toReversed/with/toSpliced are now implemented;
# toLocaleString is not — locale-aware element formatting is out of scope).
cat > "$tmp/a.ts" <<'TS'
function main(): void { const a = [3,1,2]; console.log(a.toLocaleString()); }
TS
if node exporter/exporter.js "$tmp/a.ts" "$tmp/a.json" "$tmp/al.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: unsupported array method accepted"; fail=1
fi
# new Map(iterable) seeding and m.entries() are now implemented (conformance_fixes
# §3). Test methods that remain unsupported instead.
# unsupported Set method (Set.prototype.union is not implemented)
cat > "$tmp/b.ts" <<'TS'
function main(): void { const s = new Set<number>([1,2]); const u = s.union(new Set<number>([3])); console.log(u.size); }
TS
if node exporter/exporter.js "$tmp/b.ts" "$tmp/b.json" "$tmp/bl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: Set.union accepted"; fail=1
fi
# unsupported Map method (Map.prototype.groupBy / etc. — use a clearly-absent one)
cat > "$tmp/c.ts" <<'TS'
function main(): void { const s = new Set<number>([1,2]); const u = s.intersection(new Set<number>([1])); console.log(u.size); }
TS
if node exporter/exporter.js "$tmp/c.ts" "$tmp/c.json" "$tmp/cl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: Set.intersection accepted"; fail=1
fi
# unsupported Object static arity (most common Object reflection helpers are
# implemented; malformed calls still reject at export time).
cat > "$tmp/d.ts" <<'TS'
function main(): void { console.log(Object.fromEntries()); }
TS
if node exporter/exporter.js "$tmp/d.ts" "$tmp/d.json" "$tmp/dl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: Object.fromEntries() accepted"; fail=1
fi
# RegExp constructors now accept dynamic inputs and throw catchable SyntaxError
# for invalid flags. Unsupported global value entry points still reject.
cat > "$tmp/h.ts" <<'TS'
function main(): void { const R: any = RegExp; console.log(typeof R); }
TS
if node exporter/exporter.js "$tmp/h.ts" "$tmp/h.json" "$tmp/hl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: RegExp value accepted"; fail=1
fi
cat > "$tmp/i.ts" <<'TS'
function main(): void { const R: any = globalThis.RegExp; console.log(typeof R); }
TS
if node exporter/exporter.js "$tmp/i.ts" "$tmp/i.json" "$tmp/il.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: globalThis.RegExp value accepted"; fail=1
fi
cat > "$tmp/j.ts" <<'TS'
function main(): void { const r: any = globalThis.RegExp("b"); console.log(r); }
TS
if node exporter/exporter.js "$tmp/j.ts" "$tmp/j.json" "$tmp/jl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: globalThis.RegExp(...) accepted"; fail=1
fi
cat > "$tmp/k.ts" <<'TS'
function main(): void { const R: any = globalThis["RegExp"]; console.log(typeof R); }
TS
if node exporter/exporter.js "$tmp/k.ts" "$tmp/k.json" "$tmp/kl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: globalThis[\"RegExp\"] value accepted"; fail=1
fi
cat > "$tmp/l.ts" <<'TS'
function choose(): string { return "b"; }
function main(): void { console.log("abc".match(choose())); }
TS
if node exporter/exporter.js "$tmp/l.ts" "$tmp/l.json" "$tmp/ll.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: dynamic String.prototype.match accepted"; fail=1
fi
cat > "$tmp/m.ts" <<'TS'
function choose(): string { return "b"; }
function main(): void { console.log("abc".search(choose())); }
TS
if node exporter/exporter.js "$tmp/m.ts" "$tmp/m.json" "$tmp/ml.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: dynamic String.prototype.search accepted"; fail=1
fi
cat > "$tmp/p.ts" <<'TS'
function main(): void { const r = /ab+/; console.log("abb".replaceAll(r, "x")); }
TS
if node exporter/exporter.js "$tmp/p.ts" "$tmp/p.json" "$tmp/pl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: RegExp object non-global replaceAll accepted"; fail=1
fi
# (matchAll with a non-global RegExp object compiles and throws V8's TypeError at the call, Session 358:
# a catchable throw, not a compile-time reject.)
[ $fail -eq 0 ] && echo "[reject-stdlib] PASS: unsupported stdlib methods rejected"
exit $fail
