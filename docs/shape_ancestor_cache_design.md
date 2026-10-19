# Shape-ancestor validation of inline-cache hits (tried, not adopted)

Experiment of Session 350 (build `x29`, not committed); runtime only
(`runtime/ts_rt.h`, `runtime/ts_rt.c`). Kept as a record: the mechanism
worked, the wall clock did not move, and the lesson is in "Outcome".

## Finding

The `-O0` statistics build of `x28` counted the inline property reads of
one compile: 498M reads, 98.8% answered in line. Of the in-line hits, 174M
matched the entry's exact shape, 11.6M a later entry, and **314M (63%)
took the slot/key validation**: the receiver's shape differed from every
entry's (the checker's objects gain fields lazily after construction, so
one constructor yields many shapes), and the probe validated the cached
slot by loading the shape's key vector and comparing the key at that slot
(`slot < len && g_ts_shape_keys[sid][slot] == key`): two dependent loads
and two compares per read, the key vector being a separate allocation per
shape. Property reads are the most frequent operation of the compile, so
this path is worth a load.

## Change

Shapes are nodes of a transition tree (a shape is its parent plus one key
with its attributes, and shapes only append), so two shapes with the same
ancestor at depth `d` agree on their first `d` keys and attributes. The
runtime keeps an **ancestor table**: for every shape, its ancestors at
depths 1..16 (one 64-byte row per shape, filled at creation from the
parent's row plus the shape itself at its own depth). An inline-cache
entry records, besides the exact shape and slot, the ancestor at depth
`slot + 1` of the shape it was filled from (the shape in which the key was
added), when `slot < 16`. The inline probe, after the exact-shape test,
compares the receiver's ancestor at that depth with the entry's: equal
ancestors mean the key is at the entry's slot with the entry's attributes
(and `slot < len` holds since the receiver's depth is at least
`slot + 1`). One load of the ancestor row replaces the key vector's two
loads and the two compares; slots at 16 or beyond keep the old
validation. Both loops of the probe (entry 0, entries 1-3) take the same
test before the slot/key validation.

Correctness does not depend on how the receiver reached its shape:
whether built by a constructor layout, a literal layout or sequential
additions from the empty shape, the ancestor at depth `slot + 1` fixes
the key sequence up to that depth. Dictionary receivers (shape 0) never
hit inline; an entry filled from one carries ancestor 0 and never matches.

## Verification

The existing object, class, GC and property-descriptor fixtures (every
conformance tier) and the inline policy gate; the `-O0` statistics build
reports the new `ancestor` path count against `keyval`. The compiler A/B
(`x29` against `x28`) is in the TODO entry.

## Outcome

The `-O0` statistics build confirmed the mechanism: of the 314M slot/key
validations per compile, 312M (99.4%) took the ancestor path. The binary
grew 55.9 → 65.0 MB (the test is inlined at every property read site, in
both probe loops), and the compiler A/B against `x28` (alternating three
runs on a loaded machine, Node 3.31–3.52 s) read 5.879 → 6.022 s median
wall (+2.4%; pairs +2.4%, +12%, −2.3%): no gain, likely a loss. Reverted.

Lesson, consistent with the tiny-leaf inlining (`x21`) and the inline
additions (`x27`): the validation loads sit behind a well-predicted
branch, so out-of-order execution hides them and removing one dependent
load buys little, while instruction-cache pressure from the extra code
at 150k read sites costs. Gains on this workload come from fewer
instructions and fewer calls on the executed path, and from smaller
code, not from shorter dependency chains in validation.
