# await/yield inside try/catch — design (exceptions across suspension)

## The conflict
Two mechanisms collide:
1. EXCEPTIONS use setjmp/longjmp: `try` does `setjmp(h->buf)`; `throw` does
   `longjmp` to the nearest handler. setjmp captures the CURRENT C stack frame.
2. COROUTINES (async/gen) are flat state machines: at await/yield the resume fn
   RETURNS to the driver and is later RE-ENTERED as a fresh C call.

A setjmp buffer captured before a suspension points at a C frame that no longer
exists after the resume fn returns. A later longjmp to it = jump to a dead stack
= UB. Also the structured `{ if(setjmp) ... else ... }` block can't be split by
the flattener. So **setjmp/longjmp EH cannot span a suspension**.

## Approach: frame-resident handler stack + re-arm setjmp on every resume
We keep using setjmp/longjmp for the *cross-function* propagation (an ordinary
callee that throws must still longjmp out), but make it coroutine-safe:

### Handler state lives in the FRAME, not the C stack
The coroutine frame gets a small fixed stack of "try handler" records. Each
record stores, instead of a `jmp_buf` captured once, the **state id of the catch
block** and the **state id of the finally block** plus the saved GC root depth.
When a `throw` happens while this handler is active, control must transfer to the
catch's state. Two sub-cases:

A) **throw originates in an ordinary (non-coro) callee**: it longjmps. We must
   catch that longjmp at the TOP of the resume function so we can convert it into
   a state transition. So the resume fn, on EVERY entry, does:
       if (setjmp(_fr->c.eh_buf) != 0) { goto _DISPATCH_CATCH; }
   `ts_eh_push` is called with this buf each time we (re-)enter a region guarded
   by a try. On a longjmp, we land at _DISPATCH_CATCH which inspects the frame's
   handler stack and jumps (goto) to the active catch's state label.

B) **throw originates inside the coroutine itself** (an explicit `throw` in the
   coro body, or a rejected await): we DON'T longjmp; we directly do the same
   `goto _DISPATCH_CATCH` after setting the pending exception. This avoids relying
   on a jmp_buf at all for the common in-coro case.

### Per-resume re-arm
Because the C frame is fresh on each resume, the setjmp must be re-executed at
the top of the resume fn. The frame's handler stack records WHICH try regions are
active (by state id), so after re-arming setjmp and jumping (via the dispatch
switch) back to the suspended state, the handler context is reconstructed from
the frame — not from C-stack-captured jmp_bufs.

### Handler stack in the frame
```c
typedef struct { int catch_state; int finally_state; int has_catch; int gc_depth; } ts_coro_handler;
// in the frame: ts_coro_handler eh[8]; int eh_top;
```
- Entering a try (in flat order): push {catch_state, finally_state, ...},
  ts_eh_push(&_fr->c.eh_buf) so cross-fn longjmps come here; record gc depth.
- Normal completion of try body: pop the handler, ts_eh_pop(), run finally inline,
  goto after-finally.
- throw (in-coro): set g_exception, goto _DISPATCH_CATCH.
- _DISPATCH_CATCH: pop the top frame handler, restore gc depth, ts_eh_pop(),
  set the caught value, goto its catch_state (or finally_state if no catch).

### Critical: ts_eh_push/pop balance across suspension
On suspend (await/yield) while inside a try, the active handler(s) remain on BOTH
the frame eh-stack AND the global g_handlers stack. But the resume fn returns to
the driver — leaving g_handlers pointing at a freed jmp_buf again! So:
- On suspend, we must POP the global handlers we pushed (ts_eh_pop for each active
  try) before returning, and RE-PUSH them on resume (re-arming setjmp with the
  fresh buf). The frame eh-stack is the source of truth for how many to re-push.

Implementation: a helper `_rearm_handlers(_fr)` called right after the dispatch
switch lands at the resumed state — it re-pushes ts_eh_push for each frame
handler and points them at _fr->c.eh_buf. And before every `return` at a suspend,
we `ts_eh_pop()` for each currently-active frame handler.

### Simplification adopted for v1 (sound + covers real code)
Full re-arm bookkeeping for arbitrary nesting is intricate. v1 supports:
- A single (non-nested) try/catch (optionally with finally) that contains
  await/yield, with the catch/finally NOT themselves containing suspensions.
- Nested try inside the same coroutine is rejected loudly (the eh stack supports
  it structurally, but we gate it to keep v1 verifiable).
- The in-coro throw path (explicit throw, rejected await) and the cross-fn longjmp
  path both convert to a goto to the catch state.

This keeps the design tractable while delivering the real-world case:
`try { const r = await fetch(...); use(r); } catch (e) { handle(e); }`.

### GC
The frame handler records gc_depth; on catch entry restore it (same reason as the
plain EH path: a longjmp/dispatch skips ts_gc_unroot calls).

## Nested coroutine-try (extension)

The single-handler scheme is generalized to a fixed-depth stack in the frame:
```c
#define TS_CORO_EH_INLINE 8
int     eh_top;                       // number of active coroutine handlers
int     eh_catch_state[TS_CORO_EH_MAX];
int     eh_gc_depth[TS_CORO_EH_MAX];
jmp_buf eh_buf;                       // single shared landing pad (re-armed each resume)
```
- `eh_top > 0` replaces the old `eh_active` flag. The INNERMOST handler is at
  index `eh_top-1`.
- Every generated handler/finally push goes through a slot allocator. The first
  eight records stay inline in the coroutine frame; deeper legal nesting spills
  to dynamically grown metadata arrays. This removes the historical unchecked
  eight-record overflow without inflating every Promise adapter frame.
- One shared `eh_buf`: a cross-function `longjmp` lands once and we dispatch to
  the innermost handler (`eh_catch_state[eh_top-1]`). This is correct because the
  innermost try is the nearest dynamically-enclosing handler.
- TryEnter: push (`eh_catch_state[eh_top] = L; eh_gc_depth[eh_top] = depth;
  eh_top++`); arm `setjmp(eh_buf)`; `ts_eh_push_coro(&eh_buf)` ONCE per try so the
  global handler stack depth matches `eh_top` (each push pairs with one pop).
- TryNormalExit: `ts_eh_pop(); eh_top--;` then goto after.
- Catch dispatch (in-coro throw, rejected await, or longjmp landing): pop the
  innermost — `eh_top--; ts_eh_pop(); restore gc depth[eh_top]; goto its catch`.
  A re-throw inside the catch then naturally targets the next handler down
  (now innermost), or ts_throw if none remain.
- On suspend while handlers active: pop ALL `eh_top` global handlers (their bufs
  go stale on return); the top-of-resume re-arm re-pushes `eh_top` of them.
- Re-throw: `throw` inside a catch — at that point eh_top has already been
  decremented (the catch's own handler was popped on dispatch), so InCoroThrow
  sees the OUTER handler as innermost. Correct.

### longjmp dispatch with the shared buf
The re-arm `setjmp(eh_buf)` at top-of-resume and at each TryEnter all target the
same buf. A longjmp returns to the most-recent setjmp on that buf. Since each
TryEnter re-arms after pushing, the buf reflects the current (innermost) C frame
position; on a fresh resume the top-of-resume re-arm covers it. The landing code
dispatches via `switch (eh_catch_state[eh_top-1])`.
