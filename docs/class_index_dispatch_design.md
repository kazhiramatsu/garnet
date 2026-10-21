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
