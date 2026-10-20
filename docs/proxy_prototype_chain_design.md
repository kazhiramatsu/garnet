# Proxies and other exotic cells on a prototype chain

Session 350, build `x64`. Runtime (`ts_rt.c`).

## Finding

`Object.create(new Proxy(target, handler))`, `Object.setPrototypeOf(o,
proxy)` and a class whose prototype chain was relinked onto a proxy put a
Proxy *inside* an ordinary object's prototype chain. The proxy cell
(`ts_proxy`: header, target, handler, revoked) does not begin with the
common object header, but every chain walk of the runtime read each link as
a `ts_object`:

- the link's `proto` word is the proxy's `target`, so the walk silently
  continued into the target, skipping every trap: `o.k` read the target's
  `k` (V8: the `get` trap's answer), `"k" in o` ignored the `has` trap, an
  assignment ignored the `set` trap, `o instanceof C` and
  `C.prototype.isPrototypeOf(o)` ignored `getPrototypeOf`;
- its property map words were read from the handler and from bytes past
  the end of the proxy cell (the cell is shorter than an object header).

A Promise or a coroutine cell on a chain (`Object.create(promise)`) had the
same out-of-cell reads.

## Change

- Every chain walk tests the link's kind once, `kind >= TS_KIND_PROMISE`
  (the cells without the common header: promise, coroutine, proxy and the
  internal kinds), one predictable branch per link that is never taken in
  a program without such links.
- A **proxy link** applies the proxy's internal method with the original
  receiver: `[[Get]]` calls the `get` trap with the receiver (or, without
  the trap, continues the same lookup on the target, so a getter there sees
  the receiver as `this`); `[[HasProperty]]` the `has` trap (or the
  target's chain); `[[Set]]` the `set` trap with the receiver, a falsish
  result being the strict-mode TypeError (without the trap the ordinary
  set continues on the target, which ends in an own property of the
  receiver); `instanceof` and `isPrototypeOf` continue from the
  `getPrototypeOf` trap's answer (or the target's prototype). A revoked
  proxy throws at the link, as V8 does.
- A **promise link** continues on `Promise.prototype` (a promise has no own
  properties); any other kind ends the walk.
- The caches stay out of it: the absent-property table and its fills
  already accept only plain-object links, and an addition is no longer
  cached when the receiver's chain holds such a link (a `set` trap added to
  the handler later must still run).
- **Reflect with a receiver.** The canonical trap body `Reflect.set(t, k,
  v, receiver)` was lowered without its receiver (`ts_reflect_set(t, k,
  v)`), so the write landed on the target instead of the receiver, and
  `Reflect.get(t, k, receiver)` ran a getter on the target with the target
  as `this` (`ts_get_dyn(t, k)`). `ts_reflect_get_recv` walks a plain-object
  target's chain with the receiver; `ts_reflect_set_recv` is OrdinarySet
  with a receiver (a setter on the chain runs on the receiver, a read-only
  property or an own accessor of the receiver fails with `false`, a
  non-extensible receiver refuses a new property, otherwise the receiver
  takes its own data property). A trap-less proxy hands a foreign receiver
  to the same functions. `TSAOT_REFLECT_RECEIVER=0` keeps the old calls for
  the parity oracle.
- **The proxy cell's size.** The inline-cache probe reads a receiver's
  shape word before testing its kind; a proxy cell (56 bytes) is shorter
  than an object header (72), so a proxy receiver at a cached read site
  read past its cell (ASan, the new fixture under GC stress). A proxy is
  now allocated at least an object header's size, zero-filled: its shape
  word reads 0, no cached layout. Promise and coroutine cells are larger
  already.

## Results

Gates all green; the compiler's A/B against `x63`: neutral (4.305 vs 4.323
s and 4.354 vs 4.373 s median; the compiler creates no proxies, the new
branch per chain link is never taken).

## Gates

Fixture `objects/proxy_prototypes`: reads through a `get` trap, through
`Reflect.get` with the receiver, getters on the target seeing the
receiver, the `has` trap and the own property that shadows it, writes
through the `set` trap (own property on the receiver, an intercepted
key), an own property that does not consult the chain, a trap-less proxy
behaving as its target, a proxy in the middle of a chain, `instanceof` and
`isPrototypeOf` through `getPrototypeOf`, a revoked proxy on the chain, a
loop at one site; the existing proxy fixtures; GC stress; conformance,
parity, bundler, selfconf; the compiler's A/B (no proxies: the new branch
is never taken).
