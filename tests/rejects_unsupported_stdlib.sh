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
# RegExp is still partial. `.test`, `.exec`, `search`, `match`, `matchAll`,
# replacement, split, and const-string constructor forms are accepted through
# scanner/QuickJS paths. Unsupported consumers, dynamic construction, and global
# value entry points must still reject at export time.
cat > "$tmp/f.ts" <<'TS'
function makePattern(): string { return "b"; }
function main(): void { const r: any = new RegExp(makePattern()); console.log(r); }
TS
if node exporter/exporter.js "$tmp/f.ts" "$tmp/f.json" "$tmp/fl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: dynamic new RegExp accepted"; fail=1
fi
cat > "$tmp/g.ts" <<'TS'
function main(): void { const r: any = RegExp("b", "gg"); console.log(r); }
TS
if node exporter/exporter.js "$tmp/g.ts" "$tmp/g.json" "$tmp/gl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: RegExp(...) invalid flags accepted"; fail=1
fi
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
cat > "$tmp/r.ts" <<'TS'
function main(): void { const r = /😀+/; console.log("x😀".matchAll(r)); }
TS
if node exporter/exporter.js "$tmp/r.ts" "$tmp/r.json" "$tmp/rl.json" 2>/dev/null; then
  echo "[reject-stdlib] FAIL: RegExp object non-global matchAll accepted"; fail=1
fi
[ $fail -eq 0 ] && echo "[reject-stdlib] PASS: unsupported stdlib methods rejected"
exit $fail
