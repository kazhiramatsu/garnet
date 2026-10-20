# Known coverage gaps (found by the conformance harness)

The syntax suite has three explicit layers:

1. `tests/conformance/exhaustive/syntax/`: legal, executable TypeScript whose
   native output must match V8.
2. `tests/conformance/rejects/`: legal TypeScript with runtime semantics not yet
   implemented; the exporter must stop with `UNSUPPORTED` instead of erasing it.
3. `tests/conformance/static/` plus `tests/bundler/`: type/declaration-only,
   module-graph, and JSX grammar.

`scripts/run_syntax_conformance.sh` validates all three layers. Its AST guard
checks every TypeScript 5.9 source-expressible node kind (excluding compiler
recovery/transform nodes, the compiler-illegal `with` statement, and one legacy
internal import-type wrapper), all operator families, and all modifier families.

Current intentional legal-syntax rejects are:

- BigInt literals and arithmetic;
- standard/experimental decorators;
- `using` and `await using`;
- class auto-accessors;
- tagged templates (template object identity and `.raw`);
- `new.target` and `import.meta`;
- dynamic `import()`;
- import/export attributes;
- CommonJS/namespace `import =`;
- JSX namespaced names.

Historical items below are retained as a record of bugs found by earlier
conformance sweeps; many are already fixed.

## Found in exhaustive sweep (session 2)

(All items in this section now FIXED — listed for historical context. The
exhaustive tier passes 37/37 as of session 4.)

- ~~**Inliner local-collision with Math.* of an inlined field expression**~~
  FIXED (session 4): replaced the `other.clone()` fallthrough in
  `inline_callee` with an exhaustive `remap_inst_operands` over every `Inst`
  variant (including recursive remap into `If`/`Loop`/`TryCatch` bodies).
  See `docs/inliner_and_loop_let_capture.md`.
- ~~**switch case fall-through**~~ FIXED (session 3): empty-bodied case
  clauses are OR'd via short-circuit `If` (BinOp has no `||` codegen).
- ~~**`continue` in a for-loop**~~ FIXED (session 3): moved the incrementor
  to the start of `cond_body`, guarded by a `first` flag. Loop kind `"forc"`
  uses a real C `continue` jumping to `cond_body`.
- ~~**bitwise operators**~~ FIXED (session 3): `& | ^ << >> >>>`, `**`, and
  `~` with JS ToInt32/ToUint32 (`ts_to_int32`/`ts_to_uint32` runtime helpers).
- ~~**variadic array push**~~ FIXED (session 3): `array.push` codegen loops
  over all args.
- ~~**`for...of` over `map.keys()`/`map.values()`**~~ FIXED (session 3):
  builtin-call expressions returning an array prefer the index loop over
  the dynamic iterator protocol.
- ~~**`for...of` over a string**~~ FIXED (session 3): when the receiver is
  statically a string, use `GenericLen` + `string.charAt` for char iteration.
- ~~**closure capture of a loop `let i`**~~ FIXED (session 4): per-iteration
  cell allocation in `cond_body`, seeded from the previous iteration's cell
  value. See `docs/inliner_and_loop_let_capture.md` for the spec-aligned
  ordering (update runs on the NEXT iteration's cell, so closures captured
  in iter-N retain iter-N's value).
- ~~**higher-order `compose(f,g)(x)`**~~ FIXED (session 3): captured parameter
  values are now stored into their cells at function entry.
- ~~**parseInt/parseFloat as bare calls**~~ FIXED (session 3): added
  `isNaN`/`isFinite` globals, plus `NaN`/`Infinity` identifiers via the new
  `ConstVal::NaN`/`PosInf`/`NegInf` (NaN isn't valid JSON, so a dedicated
  tag is required).

## Additional fixes (session 4) — found while implementing the above

- **SROA scalarized non-numeric fields as `Primitive` doubles**: previously
  `class Stack { items: number[] = [] }` had its `items` field reduced to a
  double, corrupting the array pointer. Fixed by selecting `Reference` vs
  `Primitive` based on `numeric_fields.contains(&(cls, f))`.
- **`.push(x)` early-path didn't check receiver kind**: any `.push(x)` (one
  arg) was lowered to `ArrayPush`, including methods on user classes named
  `push`. Fixed with a `builtinReceiverKind === "array"` guard.
- **`numeric_fields` didn't inherit through the parent chain**: caught as a
  perf regression in `inherit_sroa_kernel` (192ms vs 130ms budget). Fixed
  by propagating numeric tags down to all descendants.

## FIXED (session 2)
- number-receiver methods `.toFixed()/.toString(radix)/.toPrecision()` — added
  number builtin kind + runtime ts_number_to_fixed/to_string_radix/to_precision.
- string `lastIndexOf` — added ts_str_lastindexof.
- **unary minus of a float truncated to int** (`-3.14` -> -3): infer_int_locals now
  handles UnOp (result int only if operand int). This fixed Math.abs(-floatvar) etc.

## ES5 function constructors — Tier 1 (session 319)

Supported: `new Foo()` on plain function declarations/expressions ([[Construct]]
with fn.prototype chaining, this binding, return-override), prototype-method
dispatch through the shared singleton prototype, `instanceof` with a
plain-function or any-typed RHS, catchable "X is not a constructor" TypeErrors
for arrows/methods/async/generators/non-functions. Remaining gaps:

- **bound functions are not constructable**: V8 allows `new (Foo.bind(null))()`
  (constructs Foo); our bound thunk carries no prototype/constructable flag, so
  it throws "is not a constructor" (loud, catchable — never silent).
- **"is not a constructor" name part**: V8 interpolates the NEW-SITE expression
  text (`new f()` -> "f is not a constructor"); we use the boxed fn.name (or
  "value"). Threading site text through NewDynamic would change the IR (frozen-
  twin parity), so deferred to P4+. Tests match on the message tail.
- **"Function has non-object prototype 'undefined' in instanceof check"**: V8
  interpolates the actual prototype value; we always print 'undefined'.
- **Tier 2 (not yet modeled)**: prototype REASSIGNMENT for inheritance
  (`Child.prototype = Object.create(Base.prototype)`), `Base.call(this)`
  chaining, `new.target`. The `new x()` path constructs through
  ts_construct, so these fail loudly where unsupported, not silently.
- **Class methods on foreign receivers, the two uncovered shapes**
  (docs/foreign_receivers_design.md): a typed field access in a class method
  reads a struct offset. Relinked objects (`Object.create`, `setPrototypeOf`,
  `__proto__`) and borrowed methods (`call` / `apply` / `bind` /
  `Reflect.apply`) raise the guard and take the dynamic path; two shapes do
  not: a method grafted onto a plain object and called through it
  (`o.m = C.prototype.m; o.m()`), and a method borrowed onto a sized instance
  of an UNRELATED class (the guard tests the layout's presence, not its
  class). Both read the wrong offset silently.
- **`extends` of a class through a value**: `const B = Vec; class S extends B
  {}` and a class expression extending a parameter (`(B: typeof Vec) =>
  class extends B {}`) construct instances whose inherited methods are
  missing: `TypeError: setX is not a function` (loud, catchable).
- **`__proto__` accessor (Annex B)**: `o.__proto__ = P` stores an own
  property named `__proto__` instead of relinking, and reading it does not
  return the prototype (silent; use `Object.setPrototypeOf` /
  `Object.getPrototypeOf`).
