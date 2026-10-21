#!/bin/bash
set -e
cd "$(dirname "$0")/.."
cp -r /home/claude/exporter/node_modules exporter/ 2>/dev/null || true
tmp=$(mktemp -d); fail=0
chk(){ echo "$2" > "$tmp/t.ts"; if node exporter/exporter.js "$tmp/t.ts" "$tmp/t.json" "$tmp/tl.json" 2>/dev/null; then echo "[reject-syntax] FAIL: $1 accepted"; fail=1; fi; }
# multi-level labeled break/continue is now supported (conformance_fixes §44),
# EXCEPT: multi-level labeled jumps inside explicit try/finally remain rejected
# until both the plain and coroutine emitters support the same completion scopes.
chk "multi-level break inside try/finally" 'function main(): void { let r=""; outer: for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ try{ if(j===1) break outer; }finally{ r+="f"; } } } console.log(r); }'
chk "self-referential class extends" 'class C extends C {} function main(): void { console.log(1); } main();'
chk "mutually-cyclic class extends" 'class A extends B {} class B extends A {} function main(): void { console.log(1); } main();'
# A base that is not a class declaration (a mixin call, a class-valued binding)
# was neither laid out nor linked: the instance lacked the base's fields and
# methods (silent wrong values before). `extends ns.Base` is a class name.
chk "class extending a mixin call" 'class A { a = 1; } function mix<B extends new (...a: any[]) => object>(b: B) { return class extends b {}; } class M extends mix(A) {} console.log(new M());'
chk "class extending a class-valued constant" 'const K = class { k = 1; }; class D extends K {} console.log(new D().k);'
chk "value import linkage" 'import { value } from "./dep"; console.log(value);'
chk "lexical TDZ read" 'console.log(x); let x = 1;'
chk "lexical TDZ self read" 'let x = x; console.log(x);'
chk "destructured rest parameter"  'function f(...{a}: any): void {} function main(): void { console.log(1); }'
# Class capture of enclosing-function locals: constructors / field initializers /
# dynamic-keyed members now THREAD function-local cells (conformance_fixes §90), so
# the factory-function pattern works. Still loud-rejected: a NAMED (vtable) method
# or accessor capturing a function-local (the vtable ABI can't thread the cell).
# (Static dynamic/symbol computed members and dynamic/symbol instance accessors are
# now SUPPORTED — see tests/rejects_symbol.sh for what's installed vs still rejected.)
chk "vtable method capturing function-local" 'function make(b:number){ class C { constructor(){} scale(n:number){return b*n} } return new C(); } function main(): void { const c:any=make(10); console.log(c.scale(4)); }'
# `new X()` where X does not statically resolve to a known class or supported
# built-in: a class value held in a variable (a class can't carry a captured env
# as a runtime value), or an unsupported built-in constructor.
# Previously silently produced an empty object; now loud-rejected (§90).
# `const K = C; new K()` and the explicit-ctor factory `makeClass(z)` now work
# (§102, class value carrying classId). A NO-CTOR class that captures an enclosing
# function local is ALSO supported now (the synthesized class-value ctor threads the
# captured cells on the value's env, resolved at the value-creation site) — see
# classes/class_value_noctor_capture.ts. Still rejected: a parent EXPLICIT ctor that
# captures a function local, reached via a no-ctor subclass value (v1 conservative).
# Object.prototype.{toString,...} (§128), Array/String/Map/Set/Number/Boolean.prototype.<m>
# (§129), and Function.prototype.{call,apply,bind} (§129) are first-class values now.
# A bare `Array/String/Map/Set/Number/Boolean.prototype` object is ALSO a value now (§133/§203:
# Array.prototype is an Array exotic, so Array.isArray(Array.prototype) is true), as
# is `Array.prototype.toSorted` (toSorted/toReversed/with/toSpliced are real methods
# now, §133), and a bare `Function.prototype` (a callable no-op, typeof "function" —
# §134).
# (NOTE: now that these prototypes are values, reading an INHERITED Object.prototype
# method off one AS A VALUE — e.g. `Function.prototype.toString` / `[].hasOwnProperty`
# without calling it — yields undefined, the same pre-existing gap as `({}).toString`
# as a value. The CALL forms work. This is a known DIFF, not a reject.)
# `x instanceof C` now accepts constructor values and an `any`-typed RHS.
# Runtime validation preserves JavaScript's TypeError for a non-constructor;
# see classes/instanceof_dynamic_rhs.ts.
# (`new K(...)` on a polymorphic class value (cond ? A : B) now fully supports ctor
# args to a no-constructor member: dropped when there's no explicit-ctor ancestor, or
# forwarded as `super(...args)` to a parent ctor — even one capturing a function local
# (the parent's cells ride on the synthesized ctor's env). See §140/§141 and
# classes/new_polymorphic_args_noctor.ts. No poly-new compile-time reject remains; a
# genuinely cross-scope class value falls back to a non-constructible container that
# fails loudly at runtime.)
# An UNSUPPORTED method on a raw NUMBER read as a VALUE (not called), e.g.
# `(5).toLocaleString` without `()`. Supported number methods (toString/toFixed/
# toPrecision) are now boxed as first-class values (§101); a method we don't have
# (toLocaleString) still loud-rejects rather than silently loading undefined.
chk "unsupported number method as a value"    'function main(): void { const f:any = (5).toLocaleString; console.log(typeof f); }'
# (`super.x = v` is now fully supported — declared data field / parent accessor setter
# / static members; getter-only writes throw a catchable TypeError and undeclared
# properties create own data, both matching JS — see conformance_fixes §124–§127.)
[ $fail -eq 0 ] && echo "[reject-syntax] PASS: finally-crossing-label / import-linkage / TDZ / destructured-rest-param / class-member(vtable-method-capture) / number-method-value rejected"
exit $fail
