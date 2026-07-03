function main(): void {
  // swap via array destructuring assignment (the classic case).
  let a = 1, b = 2;
  [a, b] = [b, a];
  console.log(a, b);                       // 2 1

  // multi-target, rest, and holes.
  let x = 0, y = 0, z = 0;
  [x, y, z] = [7, 8, 9];
  console.log(x, y, z);                     // 7 8 9
  let head = 0; let rest: number[] = [];
  [head, ...rest] = [1, 2, 3, 4];
  console.log(head, rest.join(","));        // 1 2,3,4
  let p = 0, q = 0;
  [, p, , q] = [10, 20, 30, 40];
  console.log(p, q);                        // 20 40

  // object destructuring assignment: shorthand, rename, default.
  let m = 0, n = 0;
  ({ m, n } = { m: 5, n: 6 });
  console.log(m, n);                        // 5 6
  let r = 0;
  ({ a: r } = { a: 42 });
  console.log(r);                           // 42
  let s = 0, t = 0;
  ({ s = 1, t = 2 } = { s: 10 });
  console.log(s, t);                        // 10 2
}
main();
