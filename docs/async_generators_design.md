# async generators (async function*) + for-await-of

## Semantics
- `async function* g()` is lazy: calling it returns an async-generator object; the
  body runs only on `.next()`.
- `.next()` returns a Promise<{value,done}>. The body runs until:
    * a `yield e`  -> resolve the next-promise with {value:e, done:false}, suspend
    * an `await p` -> park on p (scheduler); when p settles, continue running
    * completion/return -> resolve the next-promise with {value:ret, done:true}
- `for await (const x of g())` drives it: loop { r = await g.next(); if(r.done)break; x=r.value; BODY }

## State machine: two suspension triggers, one flat body
The flat state machine already supports both await and yield suspensions. The only
differences for an async generator vs the existing modes:
- AWAIT suspension: park on the awaited promise via ts_await_register (scheduler
  resumes). On resume, continue. (same as Async mode)
- YIELD suspension: resolve the CURRENT next-promise with {value,done:false}, then
  return to the .next() caller. The next .next() creates a new next-promise, sets
  c->result to the sent value, and resumes. (like Generator yield, but resolves a
  promise instead of just setting c->yielded)
- COMPLETION/RETURN: resolve the current next-promise with {value,done:true}.

So we add SmMode::AsyncGenerator where:
- Await suspend == Async await suspend.
- Yield suspend == resolve next-promise {value, done:false} + return.
- Return/fall-off == resolve next-promise {value, done:true}.

## Runtime
- `ts_coro` owns a FIFO of `{promise,value,kind}` requests. `.next()`, `.throw()`,
  and `.return()` append a request; only the head may drive the frame. This is
  required because callers may issue several requests before any of their
  promises settle.
- `ts_asyncgen_new_v(coro)` returns the lazy async-generator object and marks the
  frame as async-generator-owned.
- The active request's promise is stored in `c->ret`. Await suspensions retain
  ownership of the frame; yield/return/rejection settles that promise, removes
  the head, and starts the next queued request.
- `yield e` first awaits `e`, then resolves `{value,done:false}`.
- `.return(v)` first awaits `v`. Fulfillment injects an internal return
  completion so user `catch` cannot consume it but every `finally` still runs;
  rejection is injected as a normal throw. A return request against an
  unstarted/completed generator also awaits its argument.
- Completion drains later queued requests in FIFO order. `.next()` receives
  `{undefined,true}`, `.throw(e)` rejects, and `.return(v)` awaits `v` and
  receives `{v,true}`.

## Resolving {value,done} object
We build a small object {value, done} and resolve the next-promise with it. Helper
ts_iter_result(value, done) builds that object (reuses F_value/F_done fields).

## for-await-of lowering (exporter)
for await (const x of E) BODY ->
  const g = E;                       // async-generator (or async-iterable) object
  while (true) {
    const r = await g.next();        // r is {value,done}
    if (r.done) break;
    x = r.value;
    BODY
  }
The await + .next() reuse existing await lowering + a CallBuiltin "asyncgen.next".
Nested for-await works because each loop has its own g/r locals (same as for-of gen).

## v1 scope
- await and yield in the async-generator body, including in loops/conditionals
  (the flat state machine handles it).
- for-await-of over an async generator, nested.
- try/catch/finally with suspension inside async generators reuses the coroutine EH
  paths (same flat machinery); supported as for async/generator.
- concurrent `.next/.throw/.return` requests and IteratorClose on early loop exit.
- `yield*` delegation and the general async-iterator protocol are implemented by
  the shared iterator lowering; the runtime request queue remains specific to
  Garnet async-generator frames.
