// @ts-nocheck
// A `.length` typed as a string's or an array's meets what the type does not say: a String object or a subclass of it, an
// object behind a lie, null and undefined. It answered 0 for all of them (silent).
const t = (n, f) => { try { console.log(n, f()); } catch (e) { console.log(n, e.name); } };
function u(a: string | number[]) { return a.length; }
class L { length = 9; }
class G2 { get length() { return 11; } }
class S extends String { hi() { return this.length; } inner() { const q = this; return q.length; } }
class S2 extends S { twice() { return this.length * 2; } }
for (const [n, v] of [["literal", { length: 5 }], ["string", "abc"], ["empty", ""], ["array", [1]], ["typed", new Uint8Array(2)], ["function", function (a, b) {}], ["instance", new L()], ["getter", new G2()],
  ["String object", new String("abcd")], ["args", (function () { return arguments; })(1, 2, 3)], ["proxy", new Proxy({ length: 3 }, {})], ["proxy array", new Proxy([1, 2], {})], ["null", null], ["undefined", undefined]]) {
  t(n, () => u(v));
}
const s = new S("abc");
console.log(s.length, s.hi(), s.inner(), new S("").length, new S2("ab").twice(), new S2("ab").length, s["length"], s.toUpperCase(), s[1], Object.keys(s));
