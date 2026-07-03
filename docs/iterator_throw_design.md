# iterator .throw() and its propagation through yield*

## Semantics
`g.throw(e)` resumes a suspended generator by raising `e` at the paused yield
point (as if `throw e` executed there). If the body's try/catch catches it, the
generator may yield/return normally; otherwise e propagates out of .throw().

In a yield* delegation, when the OUTER generator is suspended inside `yield* inner`
and the caller does `outer.throw(e)`, the throw is forwarded to `inner.throw(e)`.

## Mechanism (reuse the await-reject path)
A generator's yield-resume point already has a precedent: the async await-resume
checks `c->rejected` and, if set, throws `c->result` at that point, dispatching to
the innermost active coroutine catch (eh_top) or ts_throw. `.throw()` is the same
operation for a yield point. We therefore:
- add a yield-resume guard identical to the await one: after `S{n}:`, if
  `c->rejected` is set, throw `c->result` (dispatch to active catch or ts_throw),
  else use `c->result` as the yield's sent value.
- ts_gen_throw(genobj, exc): if done -> rethrow exc to caller (ts_throw). Else set
  c->rejected=1; c->result=exc; resume. After resume, clear rejected; build the
  {value,done} result from c->yielded/c->done as ts_gen_next does. If the generator
  did NOT catch, the resume's ts_throw longjmps out; ts_gen_throw must let that
  propagate (it runs in the caller's frame, so the caller's handler catches it).
- ts_asyncgen_throw(genobj, exc): same, but resolves/rejects the next-promise. If
  the body catches and yields, resolve {value,false}; if it returns, resolve
  {value,true}; if uncaught, the asyncgen reject-buf path rejects the next-promise.

## yield* forwarding
The yield* driving loop currently only calls it.next(sent). To forward .throw(),
the OUTER generator must, when it is itself thrown into at the yield* point, call
inner.throw(e) instead of inner.next(sent). Implementation: the yield inside the
yield* loop becomes a point where, on resume-by-throw, we route to inner.throw.

Concretely we lower the yield* step as:
  sent = yield r.value            // may resume normally OR by throw
On a normal resume: r = it.next(sent).
On a throw resume: r = it.throw(thrownValue).
We can't see "how we were resumed" at the TS level, so we lower yield* with an
explicit throw-aware driver using a try/catch around the yield:
  try { sent = yield r.value; mode = NEXT; }
  catch (e) { thrown = e; mode = THROW; }
  if (mode === THROW) r = it.throw(thrown); else r = it.next(sent);
For our generators it.throw is the builtin generator.throw; for custom iterators
it is a dynamic .throw() call (if present; else the catch rethrows e outward,
matching spec: a delegate without throw() causes a TypeError/closes — we rethrow).

## Scope / limitations
- v1 supports .throw() on our (sync) generators and yield* forwarding for sync
  generators. async generator .throw() is added symmetrically.
- custom-iterator .throw() forwarding: only when the iterator has a throw method;
  otherwise the thrown error propagates out of the yield* (we do not synthesize
  the iterator-close-then-TypeError dance; we rethrow, which is observably close
  for the common cases).
