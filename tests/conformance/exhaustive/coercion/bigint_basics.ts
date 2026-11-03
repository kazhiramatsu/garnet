// @ts-nocheck
// @oracle esnext
// BigInt: literals, the operators, conversions, equality, the mix that is a TypeError.
const log = (...a) => console.log(...a);
const name = (f) => { try { return f(); } catch (e) { return e.name + ": " + e.message; } };
log(1n, -1n, 0n, 0xffn, 0o17n, 0b101n, 1_000n, 123456789012345678901234567890n);
log(typeof 1n, typeof Object(1n), String(10n), `${-5n}`, 7n + "", "" + 7n, [1n, 2n], { a: 3n }, new Map([[1n, 2n]]));
log(2n + 3n, 2n - 3n, 2n * 3n, 7n / 2n, -7n / 2n, 7n % 3n, -7n % 3n, 7n % -3n, 2n ** 100n, (-2n) ** 3n, 0n ** 0n);
log(5n & 3n, 5n | 3n, 5n ^ 3n, ~5n, ~-1n, -5n & 3n, -5n | 3n, -5n ^ 3n, -5n & -3n, 1n << 70n, 1n << -1n, -5n >> 1n, 5n >> 1n, -1n >> 70n, (1n << 70n) >> 68n);
log(123456789012345678901234567890n * 987654321098765432109876543210n, 10n ** 40n / 7n, 10n ** 40n % 7n, -(10n ** 30n) + 1n);
let i = 1n; i++; i += 2n; i *= 3n; i -= 1n; i /= 2n; i %= 5n; i **= 3n; i <<= 2n; i >>= 1n; i &= 7n; i |= 8n; i ^= 1n; log(i, i++, i, i--, --i, ++i, -i);
log(1n == 1, 1 == 1n, 1n === 1, 1n == "1", "1" == 1n, 1n == 1.5, 2n > 1, 1 < 2n, 2n > 1.5, 1n < "2", "x" < 1n, 1n < NaN, 1n == true, 0n == false, 2n ** 64n == 18446744073709551616, 2n ** 64n > 1e19);
log(1n === 1n, 2n ** 70n === 2n ** 70n, new Set([1n, 1n, 2n]).size, new Map([[10n ** 30n, "x"]]).get(10n ** 30n), [1n].includes(1n), [1n].indexOf(1n), Object.is(1n, 1n), -0n === 0n);
log(0n ? "t" : "f", 1n ? "t" : "f", !0n, !1n, 0n || "or", 1n && "and", 0n ?? "nn");
if (0n) log("wrong"); else log("zero is false");
log(BigInt(5), BigInt("12"), BigInt("  0x10 "), BigInt(""), BigInt(true), BigInt(1e21), BigInt(Number.MAX_SAFE_INTEGER), BigInt("-7"), BigInt(10n));
log(name(() => BigInt(1.5)), name(() => BigInt("x")), name(() => BigInt(undefined)), name(() => BigInt(null)), name(() => BigInt(Symbol())), name(() => new BigInt(1)), name(() => BigInt(NaN)));
log(Number(5n), Number(2n ** 53n + 1n), Number(2n ** 2000n), Number(-(2n ** 64n)), parseInt("12n"), parseFloat("1.5"), (5n).toString(), (255n).toString(16), (-255n).toString(2), (10n ** 25n).toString(36));
log(name(() => 1n + 1), name(() => 1 * 1n), name(() => +1n), name(() => Math.max(1n)), name(() => 1n >>> 0n), name(() => 1n / 0n), name(() => 1n % 0n), name(() => 2n ** -1n), name(() => JSON.stringify({ a: 1n })), name(() => (1n).toString(1)));
log(BigInt.asUintN(8, 257n), BigInt.asUintN(8, -1n), BigInt.asIntN(8, 255n), BigInt.asIntN(8, 128n), BigInt.asIntN(8, 127n), BigInt.asUintN(64, -1n), BigInt.asIntN(64, 2n ** 63n), BigInt.asUintN(0, 5n), BigInt.asIntN(0, 5n), BigInt.asIntN(1, 1n), BigInt.asUintN(200, -1n));
log(Object(1n) == 1n, typeof Object(1n).valueOf(), Object(5n) + 1n, Object.prototype.toString.call(1n), Object.prototype.toString.call(Object(1n)), BigInt.prototype.constructor === BigInt, (1n).constructor === BigInt, BigInt.prototype[Symbol.toStringTag], BigInt.length, BigInt.name);
log(({ [1n]: "k" })["1"], [10, 20][1n], (1234567n).toLocaleString(), BigInt.prototype.toString.call(Object(3n)), name(() => BigInt.prototype.toString.call(1)));
const big = 3n ** 2000n; log((big * big) % 1000007n, (big * big) / big === big, String(big).length, big.toString(16).length, BigInt(String(big)) === big);
const k1 = 7n ** 3000n, k2 = 11n ** 2500n; log((k1 * k2) % 1000000007n, (k1 * k2) / k2 === k1, ((k1 + k2) * (k1 - k2)) === k1 * k1 - k2 * k2);
const typed: bigint = 10n; const f = (x: bigint): bigint => x * 2n; log(f(typed), f(typed) > 5n, [1n, 2n, 3n].reduce((a, b) => a + b, 0n), [3n, 1n, 2n].sort((a, b) => (a < b ? -1 : 1)));
const anyv: any = 4n; log(anyv * 2n, anyv - 1n, -anyv, anyv > 3, anyv + 1n);
log(Object.getPrototypeOf(1n) === BigInt.prototype, name(() => { (1n).x = 1; }), Object.isFrozen(1n), Object.freeze(1n), Object.keys(1n).length, "x".repeat(1) + 2n, Object.getOwnPropertyNames(BigInt.prototype).sort().join());
