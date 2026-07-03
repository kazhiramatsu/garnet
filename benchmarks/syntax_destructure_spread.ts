function main(): void {
  // optional chaining + nullish
  const o: {a?: number} = {a: 5};
  console.log(o?.a ?? 0);                    // 5
  const e: {a?: number} = {};
  console.log(e?.a ?? -1);                   // -1
  // array destructuring
  const [a, b] = [10, 20];
  console.log(a + b);                         // 30
  const [, second] = [1, 2];
  console.log(second);                        // 2
  // object destructuring + rename
  const obj = {x: 3, y: 4};
  const {x, y} = obj;
  console.log(x * y);                         // 12
  const {x: renamed} = obj;
  console.log(renamed);                       // 3
  // spread
  const arr = [1, 2];
  console.log([...arr, 3, ...arr].join(",")); // 1,2,3,1,2
  // in operator
  const has: any = {foo: 1};
  console.log("foo" in has ? 1 : 0);          // 1
  console.log("bar" in has ? 1 : 0);          // 0
  // nested destructuring
  const [[p, q], r] = [[1, 2], 3];
  console.log(p + q + r);                     // 6
}

main();
