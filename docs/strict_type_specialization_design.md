# Strict Type Specialization Design

This document extends the strict-only TypeScript optimization plan beyond the
current `number`-only inferred generic monomorphization.

## Current State

The current implementation intentionally specializes only `number`:

- `typeSubst` is `Map<type-parameter-name, RefKind>`.
- `RefKind::Primitive` is treated by codegen as an unboxed numeric local
  (`double`, later sometimes `int64_t`).
- `string`, `boolean`, object, array, and class values stay as boxed/tagged
  `tsv`, so `classify()` returns `reference` for them.

That is correct, but too weak for TypeScript-oriented AOT. TypeScript can tell
us much more than "number or not", and AOT can use that information without
runtime IC guards when the program is strict and checker-clean.

## Design Principle

Split two concepts that are currently conflated:

1. **Specialization type**: the concrete TypeScript/runtime kind selected for a
   generic type parameter, used for clone identity and lowering decisions.
2. **Local representation**: how a value is stored in generated C.

`number` maps to both a specialization type and a different representation
(`double`). `string` should initially map to a specialization type but keep the
normal `tsv` representation. That is still useful: it lets the exporter lower
generic string operations to static string builtins instead of generic property
or dynamic method access.

## Internal TypeSpec

Replace the exporter-only `typeSubst: Map<string, RefKind>` with:

```ts
type TypeSpec =
  | { kind: "number"; key: "number"; refKind: "primitive" }
  | { kind: "string"; key: "string"; refKind: "reference" }
  | { kind: "boolean"; key: "boolean"; refKind: "reference" }
  | { kind: "undefined"; key: "undefined"; refKind: "primitive" }
  | { kind: "null"; key: "null"; refKind: "primitive" }
  | { kind: "class"; key: `class:${number}`; classId: number; refKind: "reference" }
  | { kind: "array"; key: string; elem: TypeSpec; refKind: "reference" }
  | { kind: "tuple"; key: string; elems: TypeSpec[]; refKind: "reference" }
  | { kind: "function"; key: string; refKind: "reference" }
  | { kind: "erased"; key: string; refKind: "unknown" };
```

The key is the canonical monomorphization key. It must be derived from the
checker-resolved structural type, not from `typeToString()` alone. `typeToString`
can preserve aliases while `getPropertiesOfType()` and `getTypeArguments()`
already expose the concrete structure.

The existing `classify()` remains as a projection:

```ts
refKindOfSpec(spec) -> spec.refKind
```

This keeps current numeric codegen working while allowing `T=string` and
`T=class:C` to drive other lowering decisions.

## Exporter Changes

Add a `typeSpecOf(node)` helper:

- If the checker type is a type parameter and `typeSubst` has a concrete
  `TypeSpec`, return that spec.
- If the type is `T[]`, `Array<T>`, `ReadonlyArray<T>`, or a tuple, substitute
  recursively.
- If the type is a class instance, return `{ kind:"class", classId }`.
- If the type is `string`, `number`, `boolean`, `null`, or `undefined`, return
  the matching primitive spec.
- If the type includes `any` / `unknown`, or cannot be resolved within the
  strict gate, return `erased`.

Then route existing lowering through `typeSpecOf()` where it currently consults
only `RefKind` or raw checker types:

- `builtinReceiverKind(expr)`: recognize `T=string`, `T=boolean`, `T[]=array`,
  and class/array specs after substitution.
- `.length`: emit `StringLen` / `ArrayLen` for substituted `T=string` /
  `T[]=array` instead of `GenericLen`.
- string/array/boolean prototype methods: emit `CallBuiltin` for substituted
  generic receivers.
- `classOfExpr(expr)`: recognize `T=class:C` so generic methods can devirtualize
  and typed-field codegen can use `paramClasses`.
- `LoadIndex` from `array<T>`: assign the result local the substituted element
  spec, so `first<T extends string>(xs:T[]) { return xs[0].length; }` can lower
  the element's `.length` as `StringLen`.

## Monomorphization Policy

Under `strictTypeOptimizations.enabled === true`, create function/class clones
for concrete specialization keys beyond number:

- `id<string>("x")` -> `id$string`
- `len<T extends string>(s:T)` called with a string -> `len$string`
- `firstLen<T extends string>(xs:T[])` called with `string[]` ->
  `firstLen$array_string` or `firstLen$string` depending on whether `T` or
  `T[]` is the type parameter.
- `getX<T extends C>(x:T)` called with `C` -> `getX$class_C`

Do not clone all reference types blindly. Use a benefit gate:

- clone if the body contains substituted builtin receiver operations,
  `.length`, `LoadIndex` element use, class field/method access, or branch
  narrowing that can become static;
- skip if the only effect is `return x` and representation stays `tsv`, unless
  the clone feeds a later inliner or measured benchmark.

Keep the erased generic version whenever any call is dynamic, `any`-tainted,
exported/open-world, or exceeds caps.

## Expected Wins By Kind

### number

Already implemented. Keeps values in unboxed numeric locals and typed numeric
fields.

### string

Initial representation stays `tsv`; the win is dispatch removal:

- `T=string` generic receiver becomes static string builtin lowering.
- `.length` becomes `StringLen`, not `GenericLen`.
- string method calls avoid prototype/dynamic dispatch.
- existing string metric/materialization passes can recognize the specialized
  IR because it contains ordinary `StringLen` / `CallBuiltin("string.*")`.

Later, a separate string representation project can add views/builders/ropes,
but that should not block TypeScript specialization.

### boolean

First step: specialize call sites and branch lowering while keeping `tsv`.

Second step: add an optional bool local representation (`uint8_t`) separate from
`RefKind::Primitive`. Codegen would box through `ts_bool(b)` only when the value
is observed as `tsv`, and conditions/logical-not can use the raw bit directly.
This must be separate from numeric unboxing because booleans are not JS numbers.

### class / interface-like object

For nominal classes, `T=class:C` can feed the existing `paramClasses` mechanism:

- generic parameter locals can be marked as class `C`;
- `LoadField` / `StoreField` on that parameter use direct struct offsets;
- methods on `T` can devirtualize through the known class id.

For structural interfaces and object literals, start conservative. Only use a
shape spec when the object is internally allocated and closed-world. External
objects, exported functions, and dynamic/`any` writes stay erased.

### arrays / tuples

Array values remain dense `ts_array` with `tsv` elements for the first step.
Specialization still helps by propagating element `TypeSpec` after `LoadIndex`.

Future work can add packed numeric arrays, but that requires a runtime
representation change and stricter mutation/alias analysis. It should be a later
phase, not a prerequisite for TypeScript specialization.

## Wire IR Strategy

Do not widen `RefKind` immediately. It is currently used by analyzer/codegen as
a numeric unboxing signal.

Phase 1 can be exporter-only:

- `TypeSpec` drives clone naming and lowering.
- Generated IR still uses existing `refKind`.
- `string` / `boolean` locals remain `reference`.
- `number` locals remain `primitive`.

Phase 2 adds optional metadata with serde defaults:

```ts
interface Local {
  valueKind?: "number" | "string" | "boolean" | "class" | "array" | "tuple" | "unknown";
  valueSpec?: string;       // canonical TypeSpec key, debug/diagnostic
  classId?: number;         // for known class locals if useful outside paramClasses
}
```

Codegen can ignore these fields until a pass explicitly consumes them. This
keeps old behavior stable and avoids making the escape analyzer understand the
full TypeScript type lattice.

## Soundness Rules

All strong TypeScript specialization remains under the strict gate:

- all strict options effective true;
- syntactic/semantic/options diagnostics clean;
- no `any` / `unknown` in the optimized path;
- no type assertions / non-null assertions in the optimized path until a later
  audit defines which assertions are safe;
- no open exported generic API specialization without an erased fallback;
- caps for specialization count and recursive type depth;
- dynamic calls, first-class generic functions, and unknown property writes keep
  or force erased paths.

The key rule: TypeScript types choose a faster path only when the compiled
program is closed enough that all runtime producers of the value are known.

As of the first implementation slices, this rule also applies to legacy
explicit type-argument specializations. `f<number>(x)` and `new Box<number>(x)`
do not specialize in the default exporter anymore; they require
`strictTypeOptimizations.enabled === true`, a checker-clean generic body, and
checker-clean call arguments.

Generic class receiver specialization needs one extra provenance check. A
receiver whose static type is `Box<number>` may still have been produced through
`as any` or another erased path, while the allocated object is only `Box`.
Therefore `classOfExpr()` may select `Box$number` only for a receiver expression
that is directly a safe `new Box<number>(...)` or a simple `const` alias chain
from such a `new`. Other receivers keep the erased class id and use the existing
dynamic/static fallback path.

## Implementation Slices

### Slice A: TypeSpec infrastructure

- Introduce exporter `TypeSpec`.
- Replace `typeSubst: Map<string, RefKind>` with `Map<string, TypeSpec>`.
- Keep `classify()` behavior by projecting `TypeSpec.refKind`.
- Extend explicit and inferred generic specialization keys to `number`,
  `string`, `boolean`, class, array, and tuple specs.
- Add guardrails showing `T=string` produces a clone only when the body gets a
  static lowering benefit; a pure `id<string>` passthrough should stay erased.

### Slice B: substituted builtin receiver lowering

- Make `builtinReceiverKind()` consult `typeSpecOf()`.
- Make `.length` on substituted string/array emit `StringLen` / `ArrayLen`.
- Make string/array/boolean method calls on substituted generic receivers emit
  static `CallBuiltin`.
- Add V8 comparison tests for `T extends string` generic methods.

### Slice C: class-aware generic parameters

- For `T=class:C`, set `paramClasses` for parameter locals in specialized
  function clones.
- Make `classOfExpr()` consult `typeSpecOf()`.
- Verify generic field loads and method calls use typed struct/devirt paths.

### Slice D: element spec propagation

- Track element `TypeSpec` for `array<T>` and tuple loads.
- Use the element spec to lower chained operations on `xs[i]`.
- Keep runtime array representation unchanged.

### Slice E: boolean local representation

- Add a codegen-only bool local representation independent from
  `RefKind::Primitive`.
- Use raw bool for conditions, `!`, comparisons that produce bool, and boolean
  generic returns.
- Box only at observation boundaries.

### Slice F: packed arrays and deeper shapes

- Optional later work. Add packed numeric arrays or typed object-literal shapes
  only after alias/mutation analysis is strong enough.

## Why This Highlights tsaot

V8 must treat these paths as speculative and guard at runtime. In strict,
checker-clean, closed-world AOT code, tsaot can turn TypeScript facts into
ordinary C decisions:

- direct helper calls instead of dynamic prototype lookup;
- direct struct fields instead of property maps;
- no hidden-class/IC guards on proven class paths;
- numeric locals already unboxed;
- future boolean locals can be raw bits.

This is the TypeScript-specific optimization story: the type checker is the
front-end proof engine, and the AOT backend emits the proven path directly while
retaining erased fallbacks for open-world cases.
