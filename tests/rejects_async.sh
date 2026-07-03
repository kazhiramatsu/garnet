#!/bin/bash
# async/await, generators, async generators, yield*, and the iterator protocol
# (for-of/for-await/yield* over custom iterables) are supported. Verify the
# remaining unsupported forms are rejected (not silently miscompiled).
set -e
cd "$(dirname "$0")/.."
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
chk(){ echo "$2" > "$tmp/t.ts"; if node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null; then echo "[reject-async] FAIL: $1 accepted"; fail=1; fi; }
# object-literal computed-name iterator method `{ [Symbol.iterator]() {} }` is now
# implemented (symbol_design.md stage 2). A computed method name that is NOT a
# symbol (a runtime string expr) remains unsupported.
chk "object-literal dynamic computed method" 'function main(): void { const k = "m" + "x"; const o: any = { [k]() { return 1; } }; console.log("x"); }'
# yield* over a number (not iterable at all)
chk "yield* over non-iterable" 'function* g(): Generator<number>{ yield* (5 as any); } function main(): void{ for (const x of g()) console.log(x); }'
[ $fail -eq 0 ] && echo "[reject-async] PASS: computed-iterator-method / yield*-non-iterable rejected"
exit $fail
