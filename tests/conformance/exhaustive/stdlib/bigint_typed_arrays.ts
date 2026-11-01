// @ts-nocheck
// @oracle esnext
// BigInt64Array, BigUint64Array and DataView's 64-bit integers.
const log = (...a) => console.log(...a);
const name = (f) => { try { return f(); } catch (e) { return e.name; } };
const a = new BigInt64Array(3), u = new BigUint64Array(a.buffer);
a[0] = -1n; a[1] = 2n ** 63n; a[2] = 2n ** 64n + 5n;
log(a, u, a[0], u[0], a[1], u[1], a[2], a.length, a.byteLength, BigInt64Array.BYTES_PER_ELEMENT, a instanceof BigInt64Array);
log(Object.prototype.toString.call(a), a[Symbol.toStringTag], name(() => { a[0] = 1; }), name(() => new BigInt64Array([1])), name(() => new Int8Array(new BigInt64Array(1))), name(() => new BigInt64Array(new Int8Array(1))));
const x = BigInt64Array.from([3n, 1n, 2n]), y = BigUint64Array.of(5n, 4n);
log(x, y, [...x], x.at(-1), x.indexOf(1n), x.indexOf(1), x.lastIndexOf(2n), x.includes(3n), x.includes(3), x.join("-"));
log(x.map((v) => v * 2n), x.filter((v) => v > 1n), x.find((v) => v < 3n), x.findIndex((v) => v === 2n), x.findLast((v) => v > 0n), x.findLastIndex((v) => v > 5n));
log(x.reduce((s, v) => s + v, 0n), x.reduceRight((s, v) => s * v), x.every((v) => v > 0n), x.some((v) => v > 2n), x.slice(1), x.subarray(1, 2), x.toReversed(), x.toSorted(), x.with(0, 9n));
const s = BigInt64Array.of(3n, -1n, 2n); s.sort(); log(s); s.sort((p, q) => (p < q ? 1 : -1)); log(s); s.reverse(); log(s);
const t = new BigUint64Array(2).fill(7n); log(t); t.fill(1n, 1); log(t, name(() => t.fill(1)), new BigUint64Array([1n, 2n]).copyWithin(0, 1));
const st = new BigInt64Array(3); st.set([1n, 2n], 1); st.set(new BigUint64Array([9n])); log(st, name(() => st.set([1])), name(() => st.set(new Int8Array(1))));
const i = BigUint64Array.of(1n, 2n); for (const v of i) log(v); log([...i.entries()], [...i.keys()], Object.keys(i));
const d = new DataView(new ArrayBuffer(16));
d.setBigInt64(0, -2n); d.setBigUint64(8, 2n ** 64n - 1n, true);
log(d.getBigInt64(0), d.getBigUint64(0), d.getBigInt64(0, true), d.getBigUint64(8, true), d.getBigInt64(8), d.getUint8(7), name(() => d.getBigInt64(9)), name(() => d.setBigInt64(0, 1)));
class B extends BigInt64Array { first() { return this[0]; } } log(new B([4n]).first(), new B(1) instanceof BigInt64Array);
