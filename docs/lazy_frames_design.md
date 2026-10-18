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
