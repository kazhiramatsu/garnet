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
- ts_coro gains nothing new structurally; we reuse `ret` as the CURRENT next-promise
  (recreated per .next()), `yielded` unused for asyncgen (value goes via promise).
- ts_asyncgen_new(coro) -> object with __coro (like ts_gen_new).
- ts_asyncgen_next(genobj) -> creates a fresh promise, stores as c->ret, sets
  c->result=undefined, and if not already running, resumes; returns the promise.
  Because an await inside may suspend, the promise resolves later (when yield or
  completion is reached). The await path uses ts_await_register which re-enters
  resume from the scheduler; that resume eventually resolves c->ret.
- A makeshift "done" guard: once the generator completed, .next() returns a promise
  resolved with {undefined, true} immediately.

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
- NOT yet: yield* delegation in async generators; async-iterator protocol on
  arbitrary objects (only our async generators).
