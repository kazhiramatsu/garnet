# Static slots at interface-typed property sites (whole-program item 3)

Implemented in Session 350 (slice `x33`); exporter, IR, emitter and
runtime. Knob `TSAOT_STATIC_SLOTS=0` disables it in the exporter (no
hints in the IR; the parity oracle sets it) and in the emitter (hints
ignored); `TSAOT_STATIC_SLOTS_LOG=1` prints the hinted sites per key.
Untyped mode (`TSAOT_UNTYPED=1`) never hints.

## Finding

The `-O0` statistics build of `x32` counted 492M in-line property reads
per compile. By key: `flags` 169M, `kind` 130M, `parent` 29M, `id` 24M,
`value` 14M, `objectFlags` 13M, `freshType` 8M, `valueDeclaration` 6M,
`resolvedSymbol` 6M, `escapedText` 5.5M, `symbol` 4.6M. The in-line
writes: `parent` 1.4M, `pos` and `end` 1.1M each, `flags` 0.6M,
`transformFlags` 0.6M, `id` 0.5M. Of the reads, 35% matched the first
cache entry's shape, 2% a later entry, and 63% took the slot/key
validation (the receiver's shape differed from every entry's). The hot
keys are the fields the constructor functions `Node`, `Token`,
`Identifier`, `Symbol`, `Type`, `Signature` and `NodeLinks` assign first:
`pos 0, end 1, kind 2, id 3, flags 4` are the same slots in all three
node constructors, `Symbol` gives `flags 0, escapedName 1, declarations
2, valueDeclaration 3, id 4, mergeId 5, parent 6, members 7, ...`, and
`Type`, `Signature` and `NodeLinks` give `flags 0`. The lesson of `x29`
(`docs/shape_ancestor_cache_design.md`): the validation loads are hidden
by speculation; what costs is the instruction count of the executed path
and the code at 49k read sites (one probe is about 110 instructions of
code, 38 executed on an exact hit and 60 on the validation path).

## Design

**Exporter.** For every module-level function declaration with an
explicit `this` parameter, the *prefix layout*: the keys of the leading
`this.k = <pure>` statements (parameters, literals, `undefined`, const
enum members and casts of those; a duplicate key, a computed key or any
other statement ends the prefix). At a property read or write whose
receiver's static type is an object type (or a union of them), the
candidate layouts are those whose `this` type is assignable to the
receiver type or vice versa (the rule of `x32`). When every candidate has
the key in its prefix and they place it at one or two distinct slots
below 16, the site carries the slots as a hint (`slots` on `LoadField` /
`StoreField`: `(s1 + 1) | (s2 + 1) << 8`, the slot of more candidates
first). `modifierFlagsCache` gets no hint on `Node`-typed receivers
(`Identifier` lacks it), `parent` gets `7, 6` (`Identifier` skips
`modifierFlagsCache`), `kind` gets `2`.

**Emitter.** A hinted `LoadField` on a plain receiver emits
`ts_get_static_inline(obj, key, s1, &ic)` (or the two-slot form), a
hinted `StoreField` `ts_set_static_inline(...)`; the constructor-layout
and class-struct paths keep precedence, and the lazy-frame variants wrap
the slow call as before.

**Runtime.** The static probe: the receiver is an object, its shape's key
vector holds `key` at `s`, the attribute byte at `s` is plain data (no
accessor; writable and the object not frozen for a write): then the value
is slot `s`, in-object or (the cold branch, since the producers slice) in
the external value vector.
Anything else takes the out-of-line path with the site's inline cache
(`ts_get_pic_checked` / `ts_set_pic`), which keeps every semantic
(prototype reads, accessors, read-only rejection, dictionaries, sized
class instances, non-object receivers and the TypeError). To make the
vector lookup branch-free below 16, every shape's key vector is allocated
with at least 16 entries, the tail filled with `TS_KEY_NONE` (no key
encoding reaches `0xFFFFFFFF`), the attribute vector padded with zeros,
and shapes 0 (dictionary) and 1 (empty) point at static all-`NONE`
vectors; so the probe needs no length test and no shape-zero test. The
executed path is about 30 instructions and the code per site about a
third of the probe's.

Why the key vector and not the exact shape: the hot receivers are
polymorphic by shape (fields added after construction fork the shapes)
but monomorphic by slot for the prefix keys, and the key vector is the
shape's own, so no cache entry is loaded or validated. A receiver built
another way (a literal with the keys in another order, a `JSON.parse`
result, an object that lost a key) simply misses.

## Verification

Fixture `objects/static_slots`: three constructor functions sharing a
prefix with one key missing from the third (hints on the shared keys, two
slots for the keys after the gap), reads and writes through interface and
union types on constructed objects, on literals with the keys in another
order and in the same order, on an object with a getter and a setter on a
hinted key (the accessor must run), on a frozen object (the write throws
in strict mode), on an object whose hinted key lives only on the
prototype, on a class instance typed as the interface, on a dictionary
(after `delete`), on `undefined` and `null` receivers (TypeError), on an
`any` receiver, and on a layout with 20 keys (slots at and beyond 16 and
beyond the first instance's in-object capacity); plus `Object.keys` order
and 20k constructions. Identical to V8 under the default and under
`TSAOT_GC_YOUNG_THRESHOLD=1`; the knob reproduces the previous output.

## Producers (slice `x34`)

The constructor prefix leaves the keys the program adds right after
construction on the cached path: `createType` assigns `id` after
`new Type`, `createTypeWithSymbol` extends that with `symbol`,
`createObjectType` with `objectFlags, members, properties, ...`,
`createLiteralType` with `value, regularType` (and the caller adds
`freshType`), the node factory's `createBaseIdentifier` with `escapedText,
jsDoc, flowNode, symbol` and `createBaseDeclaration` with `symbol,
localSymbol`. The exporter now collects every *producer layout* of the
program:

- the constructor prefix layouts, as before;
- every fresh-object store sequence: a `const`/`let` initialized (or a
  variable assigned) from a producer expression, extended by the `x.k = ..`
  statements that follow in the same statement list. A statement that
  does not let `x` escape is skipped (property reads and writes on `x`,
  comparisons, tests and values that flow into `x`'s own properties do not
  count as escapes), an `if` whose branches only store existing keys is
  skipped, and a call or construction taking `x`, a literal holding it, an
  assignment of it, a method call on it, or a capture by a nested function
  ends the sequence (the store that escapes still counts). The sequence's
  type is the variable's declared type, else the initializer's.
- a producer expression is a construction (the candidate named like the
  callee, through `A || (A = ...)`, else every candidate of the
  construction guards) or a call to a function whose returned fresh
  objects have layouts: `return <producer>` statements and returned
  sequence variables, memoized per declaration; a method call `obj.m(..)`
  resolves to the one function an object-literal property named `m` is
  bound to anywhere in the program (`baseFactory.createBaseNode`), when
  there is exactly one.

Matching a receiver type to producers is by the declared hierarchy
instead of assignability: the interface or class symbols of the type
(through `Mutable<T>`, type-parameter constraints, unions and
intersections) and their bases; a producer matches when its root is among
the receiver's symbols or the receiver's root among the producer's. The
slot rule is relaxed: the candidates that carry the key vote, up to three
distinct slots (the slot of more producers first, each probed in turn:
`ts_get_static3_inline`), the top slots must cover 80% of those
candidates, and the candidates lacking the key must not outnumber those
carrying it. A wrong prediction is only a miss.

Found along the way: a compound assignment whose target is wrapped in a
non-null assertion, a cast or parentheses (`u.objectFlags! |= 64`) fell
through every branch of the assignment-target lowering and dropped the
store silently; targets are now unwrapped and an unknown target form
rejects loudly (fixture `operators/wrapped_assignment_targets`).

Fixture `objects/static_slots_producers`: chains of producer functions
(constructor, `createType`, `createTypeWithSymbol`, object, intrinsic,
union and literal types, the fresh literal type), a method-resolved base
factory with the constructor chosen by the callee's name, conditional
stores of existing keys, a reassigned sequence variable, literals of the
same interfaces, key order, and thousands of objects through the chains.

### What the first producer build taught (x34-x37)

The first build missed 18M static reads per compile (`freshType` 8M,
`name` 2.1M, `arguments` 1M, `questionToken` 0.7M, `callSignatures`
0.6M, `target` 0.6M). A stats-only histogram of where a miss finds the
key (`static_miss_slots`) showed the predictions right and the slots
*outside the in-object area*: `ts_construct_end` learns the slack from
the constructor's own stores plus four, so a `Type` instance has 5
in-object slots and the keys the producers add later live in the
external vector. Three changes:

- the probe reads external slots as well (`ts_obj_slot_ptr`); the
  in-object path keeps its instruction count, the external branch is
  cold;
- after the static slots fail, the probe tries the slot the site's
  inline cache learned from its first miss (`ic->entries[0]`, filled by
  the out-of-line path): a receiver family the prediction did not cover
  (160k hits per compile);
- the exporter can pre-size guarded constructions to the longest
  producer layout rooted at the constructor (`construct.begin:N`,
  `TSAOT_CTOR_CAPACITY=N`). It removes the external vectors of the
  growing objects and reads 1.4% less wall time at N = 16, but costs
  memory (RSS 813 -> 892 MB at 16, 1006 MB at 24), so it is off by
  default.

The remaining misses are receivers that are not plain shaped objects
(`NodeArray.transformFlags` 282k, arrays) or lack the key (73k
`symbol`, 43k `freshType`); every miss takes the cached out-of-line
path.

## Results

In the compiler: 8,312 hinted sites (`kind@2` 2,301; `parent@6,7` 1,728;
`flags@0` 1,588 on `Type`, `Symbol`, `Signature` and `NodeLinks`;
`transformFlags@5,6` 440; `declarations@2` 402; `valueDeclaration@3`
377; `pos@0` 270; `flags@4` 243 on `Node`; `escapedName@1` 235; `end@1`
208), 10,086 static reads and 411 static writes in the generated C. The
`-O0` statistics: 351.8M static reads hit and 14.5k miss per compile,
5.69M static writes hit and 0.90M miss; the cached reads fall from 498M
to 146M and their slot/key validations from 314M to 48M; 13,104 shapes
(the padding costs about 1 MB). The binary shrinks from 55.93 to 52.46 MB
(`isThisIdentifier`: 418 to 333 instructions).

Compiler A/B, `x33` against `x32`, two rounds of three alternating runs
(outputs validated, diagnostics zero): 4.881 vs 5.463 s median wall
(pairs -10.2%, -5.1%, -10.9%) and 4.977 vs 5.530 s (pairs -10.2%,
-10.0%, -8.8%); Node 3.28 / 3.39 s, so 1.49x Node where `x32` was 1.66x.
Allocations, GC and additions are unchanged. Kernel `ctor_functions`
2.74x -> 2.49x slower than Node.

What remains on the cached path (146M reads): `value` 14.4M,
`objectFlags` 12.6M, `id` 11.6M (`type.id`), `freshType` 8.0M,
`resolvedSymbol` 5.9M, `escapedText` 5.5M, `symbol` 4.6M. The next step is
the post-construction store sequences: `createType` assigns `id` right
after `new Type` (slot 1), `createBaseIdentifier` assigns `escapedText`,
`jsDoc`, `flowNode`, `symbol` after `new IdentifierConstructor` (slots
9-12), `createObjectType` assigns `objectFlags` after `symbol` (slot 3,
or 2 for intrinsic types); the exporter can extend a layout through the
fresh object's stores in the producing function when the callee is a
guarded construction. The 0.90M static write misses deserve a per-key
histogram before that.

### Results of the producers (x37, against x33)

435 producers, 19,781 hinted sites (8,312 before), 20,824 static reads
and 1,158 static writes in the C (1,859 two-slot and 692 three-slot
forms); cached read sites 39,265 -> 28,527. Statistics (-O0): static
reads 435.7M hit / 0.6M miss per compile, static writes 4.7M hit / 4.6M
miss (additions), cached reads 146M -> 62M, out-of-line reads 5.7M; the
allocation and GC profile is x33's. Binary 52.46 -> 50.01 MB. A/B, three
alternating runs each (outputs validated, diagnostics zero): `x37` 4.882
vs 4.924 s median (pairs -0.5%, -8.3% with a slow baseline run, -0.3%);
with the capacity hint, `x36` (N = 16) 4.906 vs 5.024 s (-2.3%, -1.8%,
+1.4%) and `x35` (N = 24) 4.848 vs 4.930 s (-2.2%, -2.0%, -0.7%). Node
3.29-3.34 s, so 1.47x Node.
