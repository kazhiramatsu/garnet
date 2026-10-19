# Whole-program facts the compiler can use (design notes)

The checker sees the whole program, and the benchmark (the compiler's own
`src/compiler`) is a closed world: no `eval`, no foreign objects except
the parsed `tsconfig`, the host's file contents and the generated C host.
These notes list the facts a whole-program pass can establish, what each
one would buy on the `x28` profile, and the guard that keeps each one
safe when the static view is incomplete (an `any` flow, a dynamic key, a
replaced allocator). The rule stays: a static fact chooses the fast path
and a cheap runtime check confirms it; nothing is trusted outright.

## 1. Which function a call site reaches (callback specialization)

`binarySearch(array, key, keySelector, keyComparer)` is called through
`containsType` and `addTypesToUnion` with `getTypeId` and `compareValues`
(83 inclusive samples, 3%); `compareComparableValues` and `compareValues`
add 28 more. The callees are parameters, so every comparison is a call
through a function value, and the comparer's `a < b` is the generic
relational operator on union-typed operands.

Fact: for a function parameter of function type, the set of functions
that flow into it across the program (a 0-CFA over the IR: call sites of
the owner, the arguments they pass, closures and module-level functions
by identity). When the set is small (one or two) and its members are
module-level functions or non-capturing arrows, the exporter can clone
the owner per member set (`binarySearch__getTypeId_compareValues`), bind
the parameter to the known function and let the emitter's direct-call
path (and the tiny-leaf inliner, when it is profitable) take over.

Guard: the clone is used only at call sites whose arguments are the
known functions by identity (the exporter resolves the symbols); any
other call site keeps the generic function. No runtime check is needed
because the specialization is selected statically per call site.

Estimate: 2-3% (the `binarySearch` family alone).

## 2. Which constructor a `new` reaches (guarded direct construction)

`new NodeConstructor(kind, pos, end)` in the parser, `new SymbolLinks()`,
`new (NodeLinks as any)()`, `new Type(checker, flags)` through
`objectAllocator`: `ts_construct` has 36 inclusive samples (1.3%), 19 of
them under `getNodeLinks`. The constructor is a function value read from
a module variable or an allocator object, so the generic construction
path runs: dispatch, instance creation with learned slack, the call, the
layout adoption check.

Fact: the variable is assigned exactly once from
`objectAllocator.getXConstructor()`, the allocator object is a module
constant whose properties are never written, and `setObjectAllocator` is
unreferenced in this program. Then the constructor is the function
`Node` (etc.) and the site can allocate its layout directly
(`ts_new_object_layout(&L_Node)`) and store the fields in place.

Guard: `if (NodeConstructor == &fn_Node_value) direct else generic` at
the site: one compare, and the generic path stays available.

Estimate: about 1%.

## 3. Where a field sits for every producer of a type (static slots)

498M inline reads per compile; 63% validate a cached slot against a
shape that differs from the entry's (the ancestor table of `x29` makes
that validation one load).

Fact: for an interface `T` and a field `k`, the producers of `T`-typed
objects (object literals typed as `T` or a subtype, constructors whose
`this` type is `T` or a subtype, class instances) and the slot each gives
`k`. When every producer puts `k` at the same slot `s` (the constructor
layouts of `Node`, `Token`, `Identifier`, `SourceFile` share their first
fields; `Type`, `Symbol`, `Signature` have one constructor each), a read
`x.k` at a `T`-typed site needs no inline-cache entry: the slot is `s`
and the check is the ancestor test of `x29` against the (static) shape in
which `k` was added, or the slot/key test when the ancestor is unknown.
Producers that disagree can be normalized: the exporter may reorder a
constructor's initial stores when nothing between them can observe the
object (the layout plan already requires that), so that shared fields
get shared slots.

Guard: the ancestor / slot-key test at the site (a receiver of another
provenance, an `any` flow, a dictionary object: all fall to the generic
read).

Estimate: 2-4% beyond `x29` (the saved entry loads and the exact-shape
compare), more if normalization raises the exact-shape hit rate.

## 4. Fields that hold flag words (unboxed int32 slots)

`type.flags`, `node.flags`, `symbol.flags`, `node.transformFlags`,
`links.flags`, `objectFlags`, `checkFlags`: enum-typed fields read with
bitwise operators. `x28` converts once per local; the field itself still
holds a NaN-boxed double.

Fact: the declared type of the field is an enum (or `number` written only
with integer values at every producer, provable when every store site is
known). Then the slot can hold an int32 and the read site skip the
unboxing.

Guard: every store to the slot must either come from a site the analysis
saw (typed) or convert with a check (a non-integer stored through `any`
throws rather than truncating silently). This depends on item 3 (fixed
slots) and is the riskiest of the four.

Estimate: 1-2% after `x28`.

## 5. Facts that do not help here

- Compiler options: the options object is built from parsed JSON with
  dynamic keys; its absent reads (`isolatedModules` 426k per compile) are
  a runtime shape matter (an inline negative entry, a separate item).
- Enumeration order: pre-creating a type's lazily assigned fields (so
  that `links.resolvedType` is always a slot) is observable through
  `Object.keys` / `for in` / `JSON.stringify` on such objects; a closed
  world could prove the absence of enumeration for `NodeLinks` and
  `SymbolLinks` in particular, but `any`-typed enumeration in the
  compiler's utilities keeps the proof out of reach for `Node` and `Type`.

## Order

Item 1 first (callback specialization: exporter cloning with a knob for
the parity oracle), then item 2 (guarded direct construction), item 3
with the static slot assignment, and item 4 last. The runtime ancestor
table (`x29`) was tried first and did not move the wall clock (see
`docs/shape_ancestor_cache_design.md`): the validation it shortened is
hidden by branch speculation, so item 3's value lies in the saved entry
loads and exact-shape compares at the site, not in the validation.
