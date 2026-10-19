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
accessor; writable and the object not frozen for a write), and `s` is
in-object (`s < inline_cap`): then the value is the in-object slot `s`.
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
