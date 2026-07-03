function main(): void {
  // Reviver transforms each value bottom-up; numbers get scaled here.
  const o: any = JSON.parse('{"a":1,"b":2}', (k, v) => (typeof v === "number" ? v * 10 : v));
  console.log(o.a, o.b);                       // 10 20

  // Nested objects are revived depth-first.
  const n: any = JSON.parse('{"x":{"y":5}}', (k, v) => (typeof v === "number" ? v + 1 : v));
  console.log(n.x.y);                          // 6

  // Arrays: each element is revived (index passed as a string key).
  const a: any = JSON.parse("[1,2,3]", (k, v) => (typeof v === "number" ? v * 2 : v));
  console.log(a.join(","));                    // 2,4,6

  // Returning undefined deletes the property.
  const del: any = JSON.parse('{"a":1,"b":2}', (k, v) => (k === "b" ? undefined : v));
  console.log(del.a, "b" in del);              // 1 false

  // Every key is visited (top-level call uses the empty-string key).
  const keys: string[] = [];
  JSON.parse('{"a":1,"b":2}', (k, v) => { if (k) keys.push(k); return v; });
  console.log(keys.sort().join(","));          // a,b

  // A primitive top-level value is revived too.
  const p: any = JSON.parse("10", (k, v) => v * 3);
  console.log(p);                              // 30

  // No reviver: plain parse.
  console.log((JSON.parse('{"a":5}') as any).a); // 5
}
main();
