function main(): void {
  // new Map(iterable) seeding + for-of with [k,v] destructuring.
  const m = new Map([["x", 1], ["y", 2], ["z", 3]]);
  console.log(m.size, m.get("y"));            // 3 2
  let r = "";
  for (const [k, v] of m) r += k + v;
  console.log(r);                              // x1y2z3

  // map.entries() / keys() / values().
  console.log([...m.keys()].join(","));        // x,y,z
  console.log([...m.values()].join(","));      // 1,2,3
  console.log([...m.entries()].map(([k, v]) => k + v).join(",")); // x1,y2,z3

  // new Set(iterable) seeding (dedups) + for-of.
  const s = new Set([1, 2, 2, 3, 3, 3]);
  console.log(s.size, s.has(2));               // 3 true
  let t = 0;
  for (const x of s) t += x;
  console.log(t);                              // 6
  console.log([...s].join(","));               // 1,2,3

  // Set seeded from a generator.
  function* g(): Generator<number> { yield 5; yield 5; yield 6; }
  console.log(new Set(g()).size);              // 2
}
main();
