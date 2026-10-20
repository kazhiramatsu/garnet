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
