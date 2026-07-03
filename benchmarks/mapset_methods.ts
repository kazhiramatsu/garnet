function main(): void {
  const m = new Map<string, number>();
  m.set("a", 1); m.set("b", 2); m.set("a", 10);  // update
  console.log(m.size);            // 2
  console.log(m.get("a"));        // 10
  console.log(m.get("b"));        // 2
  console.log(m.has("c") ? 1 : 0);// 0
  console.log(m.delete("b") ? 1 : 0); // 1
  console.log(m.size);            // 1
  console.log(m.keys().join(",")); // a
  let total = 0;
  m.set("x", 5); m.set("y", 7);
  m.forEach((v, k) => { total = total + v; });
  console.log(total);             // 10 (a:10 + x:5 + y:7 = 22) wait recompute

  const nm = new Map<number, number>();
  nm.set(1, 100); nm.set(2, 200);
  console.log(nm.get(1) + nm.get(2)); // 300

  const s = new Set<number>();
  s.add(1); s.add(2); s.add(2); s.add(3);
  console.log(s.size);            // 3
  console.log(s.has(2) ? 1 : 0);  // 1
  s.delete(2);
  console.log(s.has(2) ? 1 : 0);  // 0
  console.log(s.values().join("-")); // 1-3
  let sum = 0;
  s.forEach(v => { sum = sum + v; });
  console.log(sum);               // 4
}

main();
