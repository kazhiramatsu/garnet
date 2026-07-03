# async/await + coroutine basis + fetch — detailed design

## Decision: shared state-machine coroutine basis, async first

async/await and generators both reduce to a coroutine: suspend at a point, save
live state, resume later. Two ways to realize coroutines in an AOT-to-C compiler:

1. **Stackful** (CPython-style fibers / ucontext / stack copy): save the C call
   stack at a suspension. Costly context switches, hard to GC-scan, fragile.
   Rejected — conflicts with the performance requirement.
2. **Stackless state-machine** (TypeScript downlevel, Rust async): split the body
   at each suspension into steps, lower to `switch(state)`, spill
   live-across-suspend locals into a heap **coroutine frame**. Fast (non-
   suspending path near straight-line), GC-friendly (frame is a normal heap
   object), and the SAME machinery serves async (await) and generators (yield).

We adopt (2) as a shared basis and implement async/await first; generators reuse
the state-machine builder and frame later. "Coroutine first" and "async first"
are the same work here.

## Performance principle (central)
The common case — an async function whose awaits are already-resolved (or that
does no real I/O) — must NOT pay coroutine overhead beyond a cheap check:
- async fn with NO await -> run body, wrap result in an already-resolved Promise.
  No frame, no state machine.
- `await p` where p is already settled resumes in the same drain. Only genuinely
  pending awaits (real I/O) park the frame and yield to the loop.

## Runtime (ts_rt)
- Promise: GC object (kind TS_KIND_PROMISE) with state (pending/fulfilled/
  rejected), value, and a waiters list (resume thunks).
  ts_promise_new/resolve/reject/then.
- Microtask FIFO + ts_run_event_loop(): drain microtasks until empty and no
  pending I/O; main() calls it after kicking off the top-level async entry.
- Coroutine frame: GC object (kind TS_KIND_COROUTINE) with state id, resume fn
  ptr, result/exception slot, spilled live locals. Allocated lazily.

## Codegen: state-machine lowering
Body split at each await into steps; resume fn is switch(state). Live locals
across an await live in the frame, not C stack. v1 liveness: spill all reference
locals (conservative, correct). The public C fn allocates the frame, runs step 0,
returns the function's Promise.

### IR additions
- Await { dst, operand }: suspend on operand (Promise), resume value into dst.
- Function flag is_async.

## Staged plan (this session)
1. Promise runtime + microtask queue + event loop; async fn with NO await.
2. await of a (possibly pending) Promise via state-machine + frame.
3. rejected await raises at the await point (ties into setjmp/longjmp).

## fetch
fetch(url) -> pending Promise<Response>, non-blocking. Retrieval is an I/O task
serviced by the event loop when microtasks drain; resolves the promise then
re-drains microtasks (correct ordering). Response: minimal { status, ok,
text()->Promise<string>, json()->Promise<parsed> } resolving from the fetched
body. Transport behind ts_http_get(url)->(status,body); async structure is
transport-independent so real non-blocking I/O can swap in later without changing
compiled code.
