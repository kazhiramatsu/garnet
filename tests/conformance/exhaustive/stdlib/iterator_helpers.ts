// @ts-nocheck
// @oracle esnext
// The iterator helpers: lazy, closing what they abandon; Iterator.from; the prototype chain of the built-in iterators.
const log = (...a) => console.log(...a);
const name = (f) => { try { return f(); } catch (e) { return e.name; } };
function* nat() { let i = 0; try { for (;;) yield i++; } finally { log("closed"); } }
log(nat().map((x) => x * 2).filter((x) => x % 3 === 0).take(3).toArray());
log([...nat().drop(2).take(2)], nat().take(3).reduce((a, b) => a + b), nat().take(3).reduce((a, b) => a + b, 10));
log(nat().some((x) => x > 2), nat().every((x) => x < 2), nat().find((x) => x > 1));
nat().take(2).forEach((x, i) => log(x, i));
log([1, 2].values().flatMap((x) => [x, x * 10]).toArray(), [[1], [2]].values().flatMap((x) => x).map((x) => x + 1).toArray());
log(new Set([1, 2]).values().map((x) => x * 2).toArray(), new Map([[1, 2]]).entries().toArray(), "ab"[Symbol.iterator]().toArray());
const h = nat().map((x) => x);
log(h[Symbol.toStringTag], typeof h.next, h.next(), h.return(), h.next(), Object.prototype.toString.call(h));
log(Iterator.prototype[Symbol.toStringTag], Iterator.prototype.constructor === Iterator, typeof Iterator.from, Iterator.name, Iterator.length);
log(name(() => Iterator()), name(() => new Iterator()), name(() => nat().map(1)), name(() => nat().take(-1)), name(() => nat().take(NaN)), name(() => Iterator.prototype.map.call(1, (x) => x)));
log(Object.getPrototypeOf(Object.getPrototypeOf(nat.prototype)) !== undefined, nat() instanceof Iterator, [].values() instanceof Iterator, new Map().keys() instanceof Iterator);
class Count extends Iterator { #n = 0; next() { return this.#n < 2 ? { value: this.#n++, done: false } : { value: undefined, done: true }; } }
log(new Count() instanceof Iterator, new Count().map((x) => x + 1).toArray(), [...new Count()]);
const plain = { i: 0, next() { return this.i < 2 ? { value: this.i++, done: false } : { done: true }; }, return() { log("plain closed"); return {}; } };
const w = Iterator.from(plain);
log(w !== plain, w instanceof Iterator, w.map((x) => x * 3).toArray(), Iterator.from("hi").toArray(), Iterator.from([5]).toArray());
const g = nat(); log(Iterator.from(g) === g); g.return();
const w2 = Iterator.from({ next() { return { done: false, value: 1 }; }, return() { log("wrap return"); return { done: true }; } }); log(w2.return());
const it = { next() { return { done: false, value: 1 }; }, return() { log("thrower closed"); return {}; } };
log(name(() => Iterator.prototype.map.call(it, () => { throw new RangeError("x"); }).next()), name(() => Iterator.prototype.flatMap.call(it, () => 1).next()), name(() => Iterator.prototype.some.call(it, () => { throw new RangeError("y"); })));
log(name(() => { const r = nat().map(function () { r.next(); }); r.next(); }));
log(Iterator.prototype.take.call({ next() { return { done: true }; } }, 1).next());
