function asTuple<const T extends readonly unknown[]>(t: T): T { return t; }
function firstOf<const T extends readonly number[]>(t: T): number { return t[0] as number; }
function describe<const T>(x: T): string { return JSON.stringify(x); }

function main(): void {
  const t = asTuple([1, 2, 3]);
  console.log(t.join(","));                         // 1,2,3
  console.log(firstOf([10, 20]));                   // 10
  console.log(describe({ a: 1, b: [2, 3] }));       // {"a":1,"b":[2,3]}
}
main();
