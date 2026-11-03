// @ts-nocheck
// Object.isFrozen and isSealed of what has no property: a seal sets its own bit and not the non-extensible one, so a sealed
// object with no property was not frozen (silent). An empty array and a function are left out: V8 answers isFrozen true for a
// non-extensible empty array and a sealed function, whose length and prototype stay writable (the specification: false).
class C { x = 1; }
class E {}
const cases = [["{}", () => ({})], ["create proto", () => Object.create({ h: 1 })], ["create null", () => Object.create(null)], ["one key", () => ({ a: 1 })], ["array 1", () => [1]],
  ["instance", () => new C()], ["empty class", () => new E()], ["map", () => new Map()], ["date", () => new Date(0)], ["regexp", () => /x/], ["error", () => new Error("e")]];
for (const [n, mk] of cases) {
  const row = [];
  for (const lvl of ["freeze", "seal", "preventExtensions"]) {
    const o = Object[lvl](mk());
    row.push(lvl[0] + ":" + [Object.isFrozen(o), Object.isSealed(o), Object.isExtensible(o)].map((b) => (b ? 1 : 0)).join(""));
  }
  console.log(n.padEnd(14), row.join(" "));
}
