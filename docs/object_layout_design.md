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
