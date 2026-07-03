#!/bin/bash
set -e
cd "$(dirname "$0")/.."
# Verifies (1) the strict-type-optimization PROFILE gating, (2) the new untyped
# (any) mode, and (3) the type-error gate. Note the redesign: the only escape
# hatch for ill-typed input is now TSAOT_UNTYPED=1, which compiles the whole
# program as `any` (profile short-circuits to reason "untyped"). The old
# "emit an ill-typed program but keep trusting its types" path (and thus the
# profile's reason:"typeDiagnostics" via the main path) no longer exists — by
# design, since trusting unsound types is the silent-miscompile hazard we removed.
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d)
fail=0

check_json() {
  local file="$1"
  local expr="$2"
  local label="$3"
  if ! node -e "const p=require(process.argv[1]); if (!($expr)) process.exit(1)" "$file"; then
    echo "[strict-type-opts] FAIL: $label"
    fail=1
  fi
}

cat > "$tmp/clean.ts" <<'TS'
function inc(x: number): number { return x + 1; }
function main(): void { console.log(inc(1)); }
main();
TS

# (1) default exporter (non-strict) must not enable strict type optimizations.
node exporter/exporter.js "$tmp/clean.ts" "$tmp/default.json" "$tmp/default.labels.json" >/dev/null 2>&1
check_json "$tmp/default.json" \
  'p.strictTypeOptimizations && p.strictTypeOptimizations.enabled === false && p.strictTypeOptimizations.reason === "strictProfileIncomplete"' \
  "default exporter must not enable strict type optimizations"

# (2) --strict on a clean program enables the full strict profile.
node exporter/exporter.js --strict "$tmp/clean.ts" "$tmp/strict.json" "$tmp/strict.labels.json" >/dev/null 2>&1
check_json "$tmp/strict.json" \
  'p.strictTypeOptimizations && p.strictTypeOptimizations.enabled === true && p.strictTypeOptimizations.strictProfile === true && p.strictTypeOptimizations.diagnosticClean === true && Object.values(p.strictTypeOptimizations.options).every(Boolean)' \
  "--strict clean program must enable strict type optimizations"

# (3) untyped mode disables ALL type-driven optimization even on a clean program
# AND even under --strict: profile short-circuits to reason "untyped", every
# option false. This is the safe path — everything stays boxed (JS `any`).
TSAOT_UNTYPED=1 node exporter/exporter.js --strict "$tmp/clean.ts" "$tmp/untyped.json" "$tmp/untyped.labels.json" >/dev/null 2>&1
check_json "$tmp/untyped.json" \
  'p.strictTypeOptimizations && p.strictTypeOptimizations.enabled === false && p.strictTypeOptimizations.reason === "untyped" && p.strictTypeOptimizations.strictProfile === false && Object.values(p.strictTypeOptimizations.options).every((v) => v === false)' \
  "TSAOT_UNTYPED=1 must disable all type optimizations (reason untyped)"

cat > "$tmp/dirty.ts" <<'TS'
function main(): void { const n: number = "oops"; console.log(n); }
main();
TS

# (4) the type-error gate is LOUD: an ill-typed program is refused (exit 2, no IR
# written) by default — no silent miscompile from trusting the unsound `number`.
rm -f "$tmp/dirty.json"
if node exporter/exporter.js --strict "$tmp/dirty.ts" "$tmp/dirty.json" "$tmp/dirty.labels.json" >/dev/null 2>&1; then
  echo "[strict-type-opts] FAIL: ill-typed program must be refused (type-error gate)"
  fail=1
elif [ -f "$tmp/dirty.json" ]; then
  echo "[strict-type-opts] FAIL: refused program must not write IR"
  fail=1
fi

# (5) the escape hatch: TSAOT_UNTYPED=1 lets the ill-typed program through, but in
# untyped mode (profile "untyped") so the false `number` type is never trusted.
TSAOT_UNTYPED=1 node exporter/exporter.js --strict "$tmp/dirty.ts" "$tmp/dirty_untyped.json" "$tmp/dirty_untyped.labels.json" >/dev/null 2>&1
check_json "$tmp/dirty_untyped.json" \
  'p.strictTypeOptimizations && p.strictTypeOptimizations.enabled === false && p.strictTypeOptimizations.reason === "untyped"' \
  "TSAOT_UNTYPED=1 must compile ill-typed input in untyped mode"

[ $fail -eq 0 ] && echo "[strict-type-opts] PASS: strict profile gate + untyped mode + type-error gate"
exit $fail
