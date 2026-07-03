type Concat<A extends any[], B extends any[]> = [...A, ...B];
function concat<A extends any[], B extends any[]>(a: [...A], b: [...B]): [...A, ...B] { return [...a, ...b]; }
function tupleHead<H, T extends any[]>(t: [H, ...T]): H { return t[0]; }
function rest<H, T extends any[]>(t: [H, ...T]): T { const [, ...r] = t; return r as T; }
function makeTuple<T extends any[]>(...args: T): T { return args; }

function main(): void {
  const c: Concat<[1, 2], [3, 4]> = [1, 2, 3, 4];
  console.log(c.join(","));                         // 1,2,3,4
  console.log(concat([1, 2], ["a", "b"]).join(",")); // 1,2,a,b
  console.log(tupleHead([9, "x", true]));           // 9
  console.log(rest([1, 2, 3]).join(","));           // 2,3
  console.log(makeTuple(1, "two", true).length);    // 3
}
main();
