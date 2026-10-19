// hasOwnProperty.call(o, k) and Object.prototype.hasOwnProperty.call(o, k) lower
// to the own-property check itself (the compiler's core.ts binds the method to a
// module const and calls it 600k times per compile). Every result must match V8:
// own and inherited keys, class fields, array indices and length, string
// receivers, numbers, a missing key argument, Map receivers, and null/undefined
// receivers (TypeError, as for o.hasOwnProperty(k) and Object.hasOwn).
const hasOwnProperty = Object.prototype.hasOwnProperty;
interface MapLike<T> { [key: string]: T; }
function hasProperty(map: MapLike<any>, key: string): boolean { return hasOwnProperty.call(map, key); }
class Base { inherited = 1; }
class Derived extends Base { own = 2; }
function main(): void {
  const o: MapLike<number> = { a: 1, b: 2 };
  const proto = Object.create(o) as MapLike<number>;
  proto.c = 3;
  const d = new Derived();
  const results = [hasProperty(o, "a"), hasProperty(o, "z"), hasProperty(proto, "a"), hasProperty(proto, "c"),
    Object.prototype.hasOwnProperty.call(o, "b"), (Object.prototype.hasOwnProperty).call(o, "toString"),
    hasOwnProperty.call(d, "own"), hasOwnProperty.call(d, "inherited"), hasOwnProperty.call(d, "missing"),
    hasOwnProperty.call([1, 2], "length"), hasOwnProperty.call([1, 2], "1"), hasOwnProperty.call([1, 2], "2"),
    hasOwnProperty.call("str", "length"), hasOwnProperty.call("str", "0"), hasOwnProperty.call(5, "toFixed"),
    hasOwnProperty.call(o), hasOwnProperty.call({ undefined: 1 }), hasOwnProperty.call(new Map([["k", 1]]), "size")];
  console.log(results.join(","));
  for (const r of [null, undefined]) {
    try { console.log(hasOwnProperty.call(r as any, "a")); } catch (err: any) { console.log("throws", err instanceof TypeError); }
  }
  let count = 0;
  for (let i = 0; i < 100000; i++) if (hasProperty(o, i % 3 === 0 ? "a" : "q")) count++;
  console.log(count);
}
main();
