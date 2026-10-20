# Lazily linked root frames (roadmap track C, item 2)

## Problem

Every generated function with a reference-typed local declares a root frame
on the C stack, fills its slots, links it into the frame list
(`ts_frame_push`: two stores and a load of the global frame top) and unlinks
it before every return. The compiler makes 562M such calls per compile, and
the pattern benchmark of tiny helpers taking object arguments
(`small_calls`) ran 4.7x slower than V8: at `-O2` Clang inlines the helpers,
but each inlined body still carries its own frame link and unlink, and the
frame-top dependency chain serializes them.

## Design

A function is *lazy* when its body cannot reach a collection on its own:
every instruction is one the emitter turns into collection-free C — constants,
copies, control flow, returns, globals, lengths, `typeof`/`!`/nullish tests,
strict equality, and arithmetic or comparison whose operands are unboxed
numerics — or a property read, property write or array element read, whose
inline fast paths allocate nothing. Calls, builtins, allocations, try/catch,
coercing operators on boxed operands, rest parameters and JSON roots make the
function eager. The decision is per function (`body_is_gc_free` in
`emit_c.rs`), made after the numeric classification, and applies to the
generic entry and the i64/f64 clones alike.

A lazy function still declares its frame struct and fills every slot (so the
frame is valid at any point), but emits no `ts_frame_push` in the prologue
and no `ts_frame_pop` before returns. The three operations whose slow paths
can allocate or run user code link the frame around the out-of-line call
only:

- `ts_get_pic_checked_inline_lazy(obj, key, ic, &F.h, n)` — inline-cache
  hit as before; on a miss (or an accessor) the frame is pushed, the generic
  read runs, the frame is popped.
- `ts_set_pic_inline_lazy(...)` — same for writes (an addition may grow the
  slot vector, a setter runs user code).
- `ts_array_get_lazy(arr, i, &F.h, n)` — the array path allocates nothing; a
  string receiver builds a one-character view with the frame linked.

The caller's frame (eager, since it contains a call) keeps the arguments
rooted; the callee's own locals are only ever reached from its parameters
or from objects reachable through them, and the slow paths — the only
places a collection can start — see them through the lazily linked frame.
A throw from a slow path leaves the frame linked; the catching handler
restores the frame top it saved, as it does for eager frames.

`TSAOT_LAZY_FRAMES=0` links every frame eagerly; the byte-parity oracle runs
with it.

## Not covered (follow-ups)

- A direct call to a lazy callee is still a collection point for the caller:
  the callee's slow path would link only its own frame, leaving the caller's
  locals unrooted. Linking the caller's frame just around such calls, or
  passing the caller's frame down, would extend the scheme to one more
  level.
- Builtins known not to allocate (`Math.*`, `charCodeAt`, ...) could be
  allowed.

## Round 2: register homes (Session 350, build `x62`)

### Finding

A lazy function still kept its reference locals in the frame struct: every
definition stored the slot (a slow path may link the frame at any point,
so the frame had to be current everywhere), the parameters were copied in
at entry, and the frame's address escaped into the inlined slow path.
Measured on `small_calls` while probing the read path (`x60`): the hot
helper `getObjectFlags` ran 144 instructions per call with its slow paths
present and 79 with them removed by hand, and removing the slow calls alone
took the kernel from 750 to 650 ms. The cost was not the call (it never
runs once the caches are warm) but what its presence forced on the fast
path: the slot stores, a stack frame, and the frame-top address held in a
callee-saved register across the function.

### Change

- **Homes.** In a lazy function (`TSAOT_LAZY_HOMES`, default on) every
  reference local that has a frame slot lives in a C local, `r{slot}`
  (`rv{id}` without a frame layout), initialized to `undefined`. The frame
  struct is declared uninitialized: it is a spill area now.
- **Slow paths.** Each of the three lazily linked operations becomes a
  test and a linked call. The test runs the fast path and touches no frame:
  `ts_get_static_try` (`2`, `3`), `ts_get_pic_try`, `ts_set_static_try`
  (`2`, `3`), `ts_set_pic_try`, `ts_array_get_inline_try` /
  `ts_array_get_try` (the in-line array cases of round 1). On a miss the
  emitted code stores every home into its slot, calls `ts_get_linked`,
  `ts_set_linked` or `ts_array_get_linked` (link the frame, run the
  generic operation, unlink), and reads every home back:

  ```c
  d1 = ts_to_num(({ tsv _lz;
    if (!ts_get_static_try(r0, 4, 2u, &_ts_pic_900000, &_lz)) {
      F.s0 = r0; _lz = ts_get_linked(r0, 4, &_ts_pic_900000, &F.h, 1); r0 = F.s0;
    }
    _lz; }));
  ```

- **Out of line.** The linked calls are functions in `ts_rt.c`, not inline
  helpers. The first build inlined them, and Clang hoisted the frame-top
  address (needed by the push before the call and by the pop after it) into
  a callee-saved register at function entry, so the fast path still saved
  and restored two registers: no gain on `small_calls`. Out of line, the
  caller needs no frame-top address and no callee-saved register; a
  function with one slow path is a leaf on its fast path (the stack frame
  and the link-register save move into the slow block), one with several
  keeps a small prologue (Clang's shrink-wrapping places the save point at
  the common dominator of the slow blocks).
- The eager functions, the coroutine bodies and the parity oracle
  (`TSAOT_LAZY_FRAMES=0`) are unchanged; `TSAOT_LAZY_HOMES=0` keeps the
  frame slots as the homes (round 1).

### Why the spill and the reload

The spill is what correctness rests on: the linked frame is the only root
of the function's locals during the slow call (a getter can detach an
object from every other root, `gc/lazy_frame_getter`), and without the
spill the frame the collector scans is uninitialized memory (removing the
spills from the new fixture's C crashes it under the default thresholds).
The reload keeps the homes equal to the slots: a minor collection that
promotes a young object rewrites the slot from the object's handle to its
old pointer. The handle itself stays valid while the object lives (handles
are freed with their cell), so a stale home would still resolve today;
the reload costs nothing on the fast path, removes the handle indirection
from the later accesses, and keeps the scheme correct under a collector
that retires a handle on promotion.

### Gates

Fixture `gc/lazy_homes_reload` (a getter that detaches both locals behind
a static-slot read, an inline-cache read on `any` with fresh arguments, a
reference returned after the slow path, setters behind a static slot and
the inline cache, a home reassigned in a loop with getters on some links,
an element read on a string reached through an array type), added with
`gc/lazy_frame_getter` to the GC stress gate. Conformance, parity (the
oracle runs without lazy frames), bundler, selfconf, units, inline policy;
the compiler's A/B.

### Results

- The compiler: 3,315 emitted function bodies (entries and numeric clones)
  keep their reference locals in homes; 2,097 linked slow-path sites (1,937
  reads, 95 writes, 65 element reads); binary 49.15 -> 49.10 MB. A/B
  against `x61`, two rounds of three alternating runs: 4.431 vs 4.431 s
  and 4.435 vs 4.444 s median, five of six pairs equal or faster: neutral
  (the compiler's hot helpers mostly have several slow paths, which keep
  the small prologue).
- `small_calls`, built from the same JSON with and without the knob, run
  interleaved with equal-length binary names: 721 vs 725 ms at the default
  layout, 734 vs 764 ms with `-falign-functions=64`; the other kernels
  within noise. The first build (inlined linked calls) measured 7.8% slower
  in a quick run, which turned out to be layout: two builds of identical C
  differ by up to 5% depending on the binary name's length alone (the
  initial stack position shifts with `argv`), so kernel A/Bs need equal
  name lengths and more than one layout.
