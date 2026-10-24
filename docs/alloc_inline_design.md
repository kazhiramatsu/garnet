# The young allocation in line (session 352, slice AU)

## Problem

tsc-ts allocates 7.4 M cells for one checker (3.5 M class instances, 2.4 M
arrays, 0.9 M strings). Each went through `gc_alloc`, an out-of-line
function of a few dozen instructions: the budget test (`gc_before_alloc`),
the size class's bump (`gc_cell_alloc`), the heap accounting, the header's
kind and generation, the young-log test and three counters. The profile put
`gc_alloc` itself at 1.2% of the typed compile's samples, with `gc_cell_alloc`
and `gc_before_alloc` another 1.2%: a third of that is the call, its
prologue and the spills around it, at every constructor.

## Design

`gc_alloc` and `gc_alloc_pretenured` are inline functions; the refill of a
size class, a large cell, the conservative-roots bit and the young log stay
calls. Nothing else changes: the same tests in the same order, the same
counters, so collections happen at the same allocations.

## Measurements

| program | before | after |
|---|---|---|
| tsc-ts typed, one checker, instructions | 22.77 G | 22.72 G (-0.23%) |
| cycles | 5.30 G | 5.28 G (-0.46%) |
| wall | 1.23 s | 1.22 s |

Eight pairs; outputs identical.

## Runs the allocator does not zero (slice AW)

A run of free cells is zeroed once when a size class takes it, so that an
allocation stores no zeros itself: `gc_space_refill` and its memsets were
2.2% of the typed compile's samples, 855 MB zeroed for one checker. Half of
those bytes are class instances (3.5 M of them, 410 MB), and every byte of a
class instance is written before it is read: the allocator writes the whole
32-byte prefix (the header, the prototype, the class word, the shape, the
sidecar pointer) and the generated code writes every field, `undefined`
into a boxed one and, from this slice, zero into a numeric one (which relied
on the zeroed run before). Young class instances therefore come from a
fourth family of size classes, `g_cclass_sized`, whose runs the refill does
not zero. No collection can run between the allocation and the stores (the
generated code allocates nothing in between), so no scan sees a cell before
it is written. A pretenured instance, a cell under ASan (where every cell is
zeroed when handed out) and every other kind are as before. Every walk of
the size classes' block lists covers the fourth family: the full
collection's sweep (a first build missed it, so promoted cells in those
blocks kept their marks and their children were never traced again), the
conservative-roots cursor bookkeeping and the fate statistics; the dynamic
construction path (`new` through a class value) zeroes numeric fields itself.

| program | before | after |
|---|---|---|
| tsc-ts typed, one checker, instructions | 22.73 G | 22.70 G (-0.10%) |
| cycles | 5.29 G | 5.27 G (-0.53%) |
| wall | 1.23 s | 1.22 s |

Eight pairs; outputs identical. The zeroing of the other kinds' runs (arrays,
strings, closures, maps) stays: their constructors rely on it.
