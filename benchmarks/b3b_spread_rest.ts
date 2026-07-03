function sum(...nums: number[]): number { let s = 0; for (const n of nums) s = s + n; return s; }
function main(): void {
  // object spread + override
  const base = {x: 1, y: 2};
  const ext = {...base, z: 3, x: 10};
  console.log(ext.x + ext.y + ext.z);       // 25
  // destructuring defaults
  const {a = 5, b = 6} = {b: 20} as {a?: number, b?: number};
  console.log(a + b);                         // 25
  const [p = 1, q = 2, r = 3] = [undefined, 20] as (number|undefined)[];
  console.log(p + q + r);                     // 24 (1+20+3)
  // rest param
  console.log(sum(1, 2, 3, 4));               // 10
  // call spread
  const nums: number[] = [5, 6, 7];
  console.log(sum(...nums));                  // 18
  console.log(sum(1, ...nums, 100));          // 119
  // combined: spread into rest
  const merged = {...base, ...ext};
  console.log(merged.x);                      // 10
}

main();
