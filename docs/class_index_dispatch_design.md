# Class index and dispatch

## Why

After the receiver class hints and the shared prototypes
(`docs/receiver_class_hints_design.md`), tsc-ts's property cache time is
still a quarter of its profile, and most of it is dispatch:

- polymorphic method calls (`forEachChild`, `visit`, `visitNode`, `lookup`:
  abstract or overridden methods of stable hierarchies) find their method
  through the receiver's prototype, two cache probes megamorphic across the
  hierarchy, then call the generic entry with an argument array; devirt
  keeps them dynamic because a stable class has no table to index (and an
  abstract method has no slot in its class at all);
- fields an intermediate class declares, and leaf fields behind a
  prototype test that only an exact class passes;
- an `instanceof` that answers false walks the whole prototype chain.

scriptc compiles the same source with a vtable pointer in every instance
(its object header is 16 bytes), each table starting with the class's id
interval: `instanceof` is one range comparison and a virtual call one
indirect call with typed arguments.

## Design

- **The class index.** `ts_obj_common` gains `uint32_t cls`: for a sized
  instance, its class's position in a depth-first numbering of the class
  forest, plus one (0 for every other object), so a class and its
  subclasses are one interval `[lo, lo + span)`. The space is
  `prop_index_cap`'s, which moves into the sparse index's own block (that
  index is rare, and its capacity is read only with it). The index is set
  where sized instances are made (the emitted allocation, `ts_new_sized`
  through a class value) and cleared when a sized instance's prototype
  changes (`setPrototypeOf`, which also raises `g_typed_slow`).
- **`instanceof C`** (C's declaration runs once, its prototype shared):
  `cls - lo_C < span_C` for a sized instance, the chain walk for anything
  else. A class evaluated again (declared in a function) is a new class at
  each evaluation with one static index, so its own `instanceof` keeps the
  chain walk (a subclass evaluated again still falls in a shared base's
  interval, rightly).
- **The index block.** The sparse property index keeps its capacity in its
  first word (`prop_index[0]`, entries from `prop_index[1]`), so the block
  pointer the collector marks and frees is unchanged.
- **Field guards**: a hinted access tests `cls - lo_D < span_D`, D the
  class declaring the field: exact for any class of the hierarchy (the leaf
  prototype test goes, intermediate classes' fields join).
- **Virtual calls**: for a stable hierarchy of classes evaluated once (a
  method of a class declared in a function may close over that evaluation),
  a table per class of the
  hierarchy's virtual methods (overridden or abstract; slots assigned top
  down, an abstract method reserving its slot), and a call
  `cls - lo < span ? VT[cls][slot](...) : dynamic`. The tables hold direct
  entries when every implementation of a slot shares one direct signature,
  the generic entries otherwise.

## Slices

1. CI1: the header field, the index block's capacity, setting and clearing
   the index; the parity oracle keeps the old text behind a knob.
2. CI2: `instanceof` by range.
3. CI3: the field guards by range.
4. CI4: the tables and virtual calls.

Each slice: conformance (default and strict profiles, GC stress), parity,
selfconf, bundler, tsc rebuilt with A/B, tsc-ts measured against scriptc
and node.

## As built (CI1-CI4)

- **The index** (`ts_obj_common.cls`; `prop_index[0]` holds the sparse
  index's capacity): the emitter numbers the class forest depth first
  (roots and children in id order), writes each sized allocation's word
  (`header.cls`, heap, stack and stack-check copies) and registers the
  table (`CLASS_INDEX_TAB`, `ts_register_class_indices`) for `new` through
  a class value (`ts_construct`). A class's prototype object carries
  `TS_CLS_PROTO`. `setPrototypeOf` on a sized instance clears its word; on
  a class prototype it raises `g_class_relinked`; on any other object (a
  dictionary made with `setPrototypeOf(o, null)`, which tsc-ts's module
  initialization does) nothing. TSAOT_CLASS_INDEX=0 restores the old text
  (the parity oracle).
- **`instanceof C`** (C's prototype shared, C's subtree stable, its root
  extending nothing the table does not record, and no class of the program
  extending a value or an expression): the interval when the word is an
  instance's and no class prototype was relinked, the chain walk otherwise.
- **Guards**: a hinted access to a field a class below the root declares
  tests the declaring class's interval (exact, and it admits instances of
  classes evaluated in functions, whose prototypes are not CLASS_PROTO);
  a root's field stays unguarded.
- **Tables**: every `Method` callee the devirtualizer left (several
  implementations: overrides, abstract methods) whose receiver class's
  subtree is stable, whose implementations take `this`, capture nothing
  and are not shadowed by an own field, gets a table over the class's
  interval (`VT_<class>_<method>`, direct entries when every implementation
  shares one direct signature, generic entries otherwise); the call tests
  the interval and calls through the table, the prototype lookup behind it.
- **Found on the way** (silent wrong values): an abstract method was
  installed on its class's prototype as function 0 (`"m" in C.prototype`,
  `C.prototype.m.call(x)` ran an unrelated function); the static
  `instanceof` answer ignored a relinked class prototype; `extends ns.Base`
  was not linked (now a class name); a base that is not a class declaration
  (a mixin call, a class-valued constant) was neither laid out nor linked
  (now rejected at compile time).

tsc-ts (the TypeScript 6.0.3 compiler project, one thread, emitting):
3.64 s -> 2.93 s; checking only 2.38 s -> 2.04 s. Interleaved against
node running the same source: 2.88 s against 3.16 s emitting (garnet 1.10x
faster, 2.3x less CPU), 2.09 s against 2.43 s checking; scriptc 1.04 s and
0.67 s. 144 tables, 1,232 table call sites, 3,589 interval `instanceof`s,
8,700 interval guards.

Not covered: a sized instance whose prototype the program replaces runs
the new class's methods on its own struct (they read their offsets: the
foreign receiver gap of `docs/foreign_receivers_design.md`); the word is
cleared, so interval checks and tables fall back for it.
