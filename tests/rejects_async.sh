#!/bin/bash
# async/await, generators, async generators, yield*, and the iterator protocol
# (for-of/for-await/yield* over custom iterables) are supported. Verify the
# remaining unsupported forms are rejected (not silently miscompiled).
set -e
cd "$(dirname "$0")/.."
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
chk(){ echo "$2" > "$tmp/t.ts"; if node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null; then echo "[reject-async] FAIL: $1 accepted"; fail=1; fi; }
# super() from an arrow function of a dynamic class (docs/dynamic_classes_design.md, Gaps)
chk "super() in an arrow of a dynamic class" 'class A { x = 1; } class B { x = 2; } const P = Math.random() < 2 ? A : B; class C extends P { constructor() { const f = () => super(); f(); } } console.log(new C().x);'
[ $fail -eq 0 ] && echo "[reject-async] PASS: the remaining unsupported forms are rejected"
exit $fail
