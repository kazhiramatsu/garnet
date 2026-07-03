#!/bin/bash
# Symbol is now fully implemented (symbol_design.md stages 1-3): Symbol(),
# user-symbol keys, well-known symbols (Symbol.iterator value + obj[Symbol.X] +
# object-literal [Symbol.iterator]()), Symbol.for/keyFor, sym.description/toString.
# This file used to assert these were rejected; it now smoke-tests that they WORK
# and produce the expected output (a positive guard against regressions).
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
# Some snippets here intentionally exercise the RUNTIME semantics of constructs the
# TS checker flags as type errors but are valid JS that garnet supports
# (`Symbol.for("k")===Symbol.for("k")` → TS2367 on `unique symbol`; `5 instanceof C`
# → TS2358 though the static [Symbol.hasInstance] hook makes it valid). Compile in
# untyped (any) mode so the type-error gate is bypassed AND the unsound types are
# never trusted — everything goes the dynamic runtime path, which is exactly what
# these JS-valid snippets need. (`rej()` cases are unaffected — they loud-reject via
# UNSUPPORTED, not type errors.)
export TSAOT_UNTYPED=1
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
$CC -c runtime/ts_rt.c -Iruntime -o "$tmp/rt.o" 2>/dev/null
ok() { # $1 = description, $2 = ts source, $3 = expected stdout (newlines as |)
  echo "$2" > "$tmp/t.ts"
  if ! node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null >/dev/null; then
    echo "[symbol] FAIL: $1 rejected (should compile)"; fail=1; return; fi
  analyzer/target/release/tsaot "$tmp/t.json" emit > "$tmp/t.c" 2>/dev/null
  $CC "$tmp/t.c" "$tmp/rt.o" -Iruntime -lm $TSAOT_LDLIBS -o "$tmp/t" 2>/dev/null
  got=$("$tmp/t" 2>&1 | tr '\n' '|')
  if [ "$got" != "$3" ]; then echo "[symbol] FAIL: $1 got '$got' want '$3'"; fail=1; fi
}
rej() { # $1 = description, $2 = ts source — must be loud-rejected by the exporter
  echo "$2" > "$tmp/t.ts"
  if node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null >/dev/null; then
    echo "[symbol] FAIL: $1 accepted (should reject)"; fail=1; fi
}
ok "Symbol.for identity"  'function main(): void { const a=Symbol.for("k"); const b=Symbol.for("k"); console.log(a===b); } main();' "true|"
ok "Symbol.keyFor"        'function main(): void { const s=Symbol.for("hi"); console.log(Symbol.keyFor(s)); } main();' "hi|"
ok "sym.toString"         'function main(): void { const s=Symbol("d"); console.log(s.toString()); } main();' "Symbol(d)|"
ok "obj[Symbol.iterator]" 'function main(): void { const o:any={}; o[Symbol.iterator]=7; console.log(o[Symbol.iterator]); } main();' "7|"
# Symbol-keyed class members (conformance_fixes: symbol member batch). Static
# methods (well-known toPrimitive + user symbols), static fields, static accessors,
# instance accessors, and dynamic-string-keyed static members all install + read.
ok "static [Symbol.toPrimitive]"    'class C { static [Symbol.toPrimitive](h:string){ return h==="number"?42:"C!"; } } function main(): void { console.log(+C); console.log(String(C)); } main();' "42|C!|"
ok "static [mySym] method"          'const s=Symbol("m"); class C { static [s](){ return 7; } } function main(): void { console.log((C as any)[s]()); } main();' "7|"
ok "static [mySym] field"           'const s=Symbol("f"); class C { static [s]=5; } function main(): void { console.log((C as any)[s]); } main();' "5|"
ok "static get/set [mySym]"         'const s=Symbol("a"); class C { static _v=1; static get [s](){ return C._v; } static set [s](x:number){ C._v=x; } } function main(): void { console.log((C as any)[s]); (C as any)[s]=8; console.log(C._v); } main();' "1|8|"
ok "static [k] dyn-string field"    'const k="dyn"; class C { static [k]=3; } function main(): void { console.log((C as any)["dyn"]); } main();' "3|"
ok "instance get/set [mySym]"       'const s=Symbol("a"); class C { _v=1; get [s](){ return this._v; } set [s](x:number){ this._v=x; } } function main(): void { const c=new C(); console.log((c as any)[s]); (c as any)[s]=8; console.log((c as any)[s]); } main();' "1|8|"
ok "instance [Symbol.toStringTag]"  'class C { get [Symbol.toStringTag](){ return "Widget"; } } function main(): void { console.log(String(new C())); } main();' "[object Widget]|"
# static [Symbol.hasInstance] hook: `x instanceof C` consults it (overrides proto walk).
ok "static [Symbol.hasInstance]"    'class C { static [Symbol.hasInstance](x:any){ return typeof x==="number"; } } function main(): void { console.log(5 instanceof C); console.log(({}) instanceof C); } main();' "true|false|"
# Symbol/dynamic-keyed generator and async methods now install too: the coroutine
# state machine is boxed as a ts_func value (identical to the proven vtable
# registration) and stored under the symbol/dynamic key. Consume via spread / .then
# (the `any`-typed receiver from `as any` would defeat for-of/.next — a separate gap).
ok "static generator [mySym]"       'const s=Symbol("g"); class C { static *[s](){ yield 1; yield 2; } } function main(): void { console.log([...(C as any)[s]()].join(",")); } main();' "1,2|"
ok "static async [mySym]"           'const s=Symbol("g"); class C { static async [s](){ return 1; } } function main(): void { (C as any)[s]().then((v:number)=>console.log(v)); } main();' "1|"
ok "instance generator [mySym]"     'const s=Symbol("g"); class C { *[s](){ yield 1; yield 2; } } function main(): void { console.log([...(new C() as any)[s]()].join(",")); } main();' "1,2|"
ok "instance async [mySym]"         'const s=Symbol("g"); class C { async [s](){ return 5; } } function main(): void { (new C() as any)[s]().then((v:number)=>console.log(v)); } main();' "5|"
[ $fail -eq 0 ] && echo "[symbol] PASS: Symbol.for/keyFor/toString/obj[Symbol.*] + symbol-keyed class members (incl. hasInstance hook + gen/async methods) work"
exit $fail
