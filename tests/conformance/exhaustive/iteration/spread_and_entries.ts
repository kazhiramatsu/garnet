function main(): void {
  // spread of a generator into an array.
  function* g(): Generator<number> { yield 1; yield 2; yield 3; }
  console.log([...g()].join(","));             // 1,2,3

  // array.entries() with index destructuring in for-of.
  const a = ["p", "q", "r"];
  let out = "";
  for (const [i, v] of a.entries()) out += i + v;
  console.log(out);                            // 0p1q2r

  // array.keys() / values().
  console.log([...a.keys()].join(","));        // 0,1,2
  for (const v of a.values()) out += v;
  console.log(out);                            // 0p1q2rpqr

  // spread combines arrays, generators, and sets.
  const s = new Set([10, 20]);
  console.log([0, ...g(), ...s].join(","));    // 0,1,2,3,10,20

  // string spread follows the string iterator: UTF-16 surrogate pairs are one element.
  console.log([..."A😀B"].map((ch) => ch + ":" + ch.length).join("|")); // A:1|😀:2|B:1
}
main();
