# Asynchronous context (`AsyncLocalStorage` of `node:async_hooks`)

Session 358. hono's context-storage middleware (`getContext()` from anywhere under a request)
keeps the request's Context in an `AsyncLocalStorage`, and its JSX renderer uses one when
`node:async_hooks` is there: the last of the survey's library gaps (docs/real_projects.md). This
document is the design: what a store is, and how the runtime carries the current context across
the continuations an async program is made of.

## The model

An `AsyncLocalStorage` is a key; the current context is an immutable chain of frames
`{ als, store, parent }`. `run(store, fn, ...args)` pushes a frame for the call and restores
the previous context when `fn` returns (synchronously: an async `fn` returns its promise then,
and the continuations inside it carry the frame they were registered under, below).
`getStore()` walks the chain for the first frame of this storage. `exit(fn)` runs `fn` under a
frame whose store is undefined; `enterWith(store)` replaces the context without restoring it;
`disable()` makes `getStore()` answer undefined from then on. `AsyncLocalStorage.bind(fn)` and
`snapshot()` capture the current context into a function that restores it around each call;
`AsyncResource` is the same capture at construction, for `runInAsyncScope` and `bind`.

Node propagates the context through every asynchronous resource. In garnet's runtime a
continuation is one of: a coroutine waiting on a promise (an `await`, a `then` callback, which
`ts_promise_then` wraps as a coroutine), a `queueMicrotask` job (a coroutine of its own, which
captures the context when it is queued), a timer, an immediate, a `nextTick` callback, or an I/O
completion that resolves a promise (its waiters are coroutines).
So the context is carried by exactly two kinds of record:

- A coroutine captures the current context when it is registered on a promise
  (`ts_await_register_v`, the one path for a pending promise's waiter and for the microtask of
  an already settled one), in a new `ts_coro.async_ctx` slot the collector visits;
  `ts_coro_resume_v` installs it for that resume and restores the resumer's context after it ran
  or threw. The capture is for one resume (`ctx_captured`): a resume nobody registered, a
  generator's `next()`, keeps its caller's context, as a generator body runs in its caller's.
  The contexts saved around a switch live on a small stack the collector marks: a saved context
  held in a C local would go stale when a collection moves it.
- A timer, immediate or tick record (`runtime/node_host.c`) captures it when it is made and
  installs it around its callback (the records are malloc'd: the slot is marked with their
  callbacks).

The context lives in one runtime global, `g_async_ctx` (a GC root), read and written by two host
methods `asyncContext()` / `setAsyncContext(v)` of `__garnet_node`. The first write sets
`g_async_ctx_used`; until then the capture and restore sites are one predictable branch each, so
a program without `AsyncLocalStorage` pays nothing on the promise path, and the coroutine record
grows by one word.

What is not propagated: an EventEmitter's listeners run synchronously in the emitter's caller's
context (as Node's do without an `AsyncResource`), and `createHook` (the async_hooks tracing
API) is not provided: its import is a compile-time error.

## Verified

`tests/conformance/exhaustive/node/async_local_storage.ts` (Node's own module is the oracle):
`run` nested and in sequence, `getStore` after `await`s, in a `then`, a `setTimeout`, a
`setImmediate`, a `nextTick`, a `queueMicrotask` and a `for await`; `exit`, `enterWith`,
`disable`, `bind`, `snapshot`, `AsyncResource.runInAsyncScope`; two storages side by side; the
survey's context_storage driver (docs/real_projects.md).
