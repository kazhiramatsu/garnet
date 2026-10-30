# Object literal and constructor layouts

## Problem

An object literal `{ a: x, b: y, c: z }` was emitted as an empty allocation
followed by one property store per key, and a constructor function
(`function Node(this, kind, pos, end) { this.pos = pos; this.end = end;
... }`) as ten stores into the fresh `this`. Each store is an *addition*:
the inline cache can never hit (the key is not there yet), so every one goes
out of line to `ts_set_pic`, probes the addition cache for the transition
and appends a slot. The compiler performs 29M such additions per compile
(19.2M addition-cache hits, 9.8M misses that walk the transition table), and
its `Node`, `Symbol`, `Type` and `Signature` constructors are exactly this
pattern. V8 avoids the cost with allocation-site boilerplates and
constructor slack tracking, learned at run time; the property sequence is
static, so an AOT compiler can do better.

## Design

**Emitter** (`layout_plan_for` in `emit_c.rs`). Per function:

- An `AllocObject` of a plain literal (no class, no explicit prototype)
  followed by stores into it, before any other instruction mentions the
  object, defines a *layout*: the keys in store order (duplicates and
  self-stores end the sequence; an `If`/`Loop`/`TryCatch` ends it). The
  allocation becomes `ts_new_object_layout(&L)` with a per-site static
  descriptor `{ shape, n, keys[] }`, and each collected store becomes
  `ts_lit_store(obj, slot, value)`. Instructions between the stores may do
  anything except mention the object: the literal is unreachable by user
  code until it is complete, so the keys being present (as `undefined`)
  early is unobservable.
- A function that takes `this` and begins with stores into it, with nothing
  between them that mentions `this` or can run user code (no call,
  builtin, construction, throw, await/yield), is a constructor-style body.
  The first store emits `int _ts_adopt = ts_obj_adopt_layout(this, &L)`;
  each store is `if (_ts_adopt) ts_lit_store(...) else <generic store>`.
  `adopt` succeeds only for a fresh empty shaped object with enough
  in-object slots (the `new` path pre-sizes instances from the learned
  slack), so `Point.call(existing)` and `super`-style chains keep the
  generic path.

**Runtime**. `ts_new_object_layout` resolves the descriptor's shape once by
walking `shape_transition` from the empty shape, then allocates the object
with `n` in-object slots, fills them with `undefined`, sets `len = n` and the
shape; the keys and attribute vectors are the shape's, exactly as if the
properties had been added one by one. If the shape table is exhausted or the
literal exceeds the in-object maximum, it adds the keys one by one with
`ts_set_named_prop` (so slot `i` is key `i` either way, shaped or
dictionary). `ts_lit_store` writes the slot (or the dictionary entry) and
runs the write barrier. `ts_obj_adopt_layout` does the same for an existing
empty object in place.

`TSAOT_LITERAL_LAYOUT=0` keeps the per-property additions; the byte-parity
oracle runs with it.

## Expected effect

One allocation and `n` slot stores per literal or constructor instead of
`n` out-of-line additions; the addition cache and the transition table are
touched once per site instead of once per object. Fixture
`objects/literal_layout` (key order and enumeration, side effects and a
throw between stores, spread after a prefix, literals in loops,
constructors through `new`, `.call` on empty and non-empty receivers, a
14-property constructor, deletion after construction).

## Follow-up (Session 350): constructors behind captured cells

The constructor rule looked for `this` in `params[0]`. A function's leading
parameters are its captured cells (`capture_count` of them), so a
module-level constructor that reads any module state had a cell there and
never matched: in the TypeScript compiler that was every `Node`, `Token`,
`Identifier`, `Symbol`, `Type` and `Signature` constructor, which kept the
per-property additions (20.2M out-of-line `ts_set_pic` calls per compile,
99% of them additions). The rule now takes `params[capture_count]`.
Fixture `objects/ctor_layout_captures` (constructors capturing a module
counter, reached through a factory object and `new` on the function value,
`.call` on empty and non-empty receivers, an inner arrow capturing `this`,
a call and a repeated key inside the store sequence, 20k instances).
Kernel `benchmarks/patterns/ctor_functions.ts` (ten adds per instance through
a factory-provided constructor): native 265 ms vs node 96 ms before the fix.


## Literal layouts through conditional values (Session 360)

A literal's layout collected the stores that follow its allocation and
stopped at the first branch. A conditional value (`a ? b : c`, `??`, `||`,
`&&`, `?.`) lowers to an `If`, so every key after one became a property
added to the built object, one shape transition and possibly an overflow
vector each. vue's parser builds a location on every node, `{ start, end:
end == null ? end : getPos(end), source: ... }`: the layout held `start`
alone, and the two additions made `getLoc` six times V8's time. The
collection now continues past an `If` whose bodies neither use nor define
the object (`inst_mentions_deep`), which holds for every literal: its values
cannot name the object it builds. A constructor's `this` sequence (the
strict collection, which also stops at a call) keeps stopping. In vue's C
the additions after a literal went from 300 to 199, and the compiler phase
ran 342 -> 323 ms. `TSAOT_LITERAL_LAYOUT_IF=0` keeps stopping. Fixture
`objects/literal_layout_conditionals` (every kind of conditional value, the
key order through `Object.keys` and `JSON.stringify`, branches that
allocate or call, a branch that throws midway).
