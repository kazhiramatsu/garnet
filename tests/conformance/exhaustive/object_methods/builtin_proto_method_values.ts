// `Array/String/Map/Set/Number.prototype.<method>` (and Function.prototype.{call,
// apply,bind}) are usable as first-class function values, like `Object.prototype.
// {toString,...}`: `typeof`
// is "function", they can be stored in a variable, and `.call`/`.apply`/`.bind`
// supply the receiver as `this` (the boxed runtime proto method is takes_this=1).
// This includes the classic `Array.prototype.slice.call(arrayLike, i)` idiom.
// (Foreign/array-like receivers are NOT coerced — out of scope; tests use the
// matching receiver type. Other builtins' prototype values, bare `X.prototype`,
// and unlisted methods still loud-reject — see tests/rejects_syntax.sh.)

const sliceV = Array.prototype.slice;
const upperV = String.prototype.toUpperCase;

function main(): void {
  // ----- Array.prototype.<m>.call : the headline idiom (these methods are the
  // ones mis-typed as `any[]`, so they exercise the call-path guard) -----
  console.log((Array.prototype.slice.call([1, 2, 3], 1) as any).join(",")); // 2,3
  console.log((Array.prototype.map.call([1, 2, 3], (x: number) => x * 2) as any).join(",")); // 2,4,6
  console.log((Array.prototype.reverse.call([1, 2, 3]) as any).join(",")); // 3,2,1
  console.log((Array.prototype.filter.call([1, 2, 3, 4], (x: number) => x % 2 === 0) as any).join(",")); // 2,4
  // a non-mis-typed array method via .call (regression for the already-working path)
  console.log(Array.prototype.join.call([1, 2, 3], "-")); // 1-2-3
  console.log(Array.prototype.indexOf.call([10, 20, 30], 20)); // 1

  // ----- value form: typeof + stored in a variable -----
  console.log(typeof Array.prototype.map, typeof sliceV, typeof upperV); // function function function
  console.log((sliceV.call([9, 8, 7], 1) as any).join(",")); // 8,7
  const dynJoin: any = "join";
  const dynSlice: any = "slice";
  console.log(([1, 2, 3] as any)[dynJoin]("-")); // 1-2-3
  console.log((([9, 8, 7] as any)[dynSlice](1) as any).join(",")); // 8,7

  // ----- String.prototype.<m>.call -----
  console.log(String.prototype.toUpperCase.call("hi")); // HI
  console.log(String.prototype.slice.call("hello", 1)); // ello
  console.log(upperV.call("abc")); // ABC

  // ----- Map.prototype.<m>.call -----
  const m = new Map<string, number>();
  Map.prototype.set.call(m, "a", 1); // returns the map; install via the proto method
  console.log(Map.prototype.get.call(m, "a")); // 1
  console.log(Map.prototype.has.call(m, "a"), Map.prototype.has.call(m, "z")); // true false
  const dynGet: any = "get";
  console.log((m as any)[dynGet]("a")); // 1

  // ----- Set.prototype.<m>.call -----
  const s = new Set<number>([1, 2]);
  Set.prototype.add.call(s, 3);
  console.log(Set.prototype.has.call(s, 3), Set.prototype.has.call(s, 9)); // true false
  const dynHas: any = "has";
  console.log((s as any)[dynHas](2), (s as any)[dynHas](9)); // true false

  // ----- Number.prototype.<m>.call -----
  console.log(Number.prototype.toFixed.call(3.14159, 2)); // 3.14
  console.log(Number.prototype.toString.call(255, 16)); // ff
  const dynToString: any = "toString";
  console.log((255 as any)[dynToString](16)); // ff

  // ----- Object.prototype methods through computed property access -----
  const obj: any = { a: 1 };
  const dynHop: any = "hasOwnProperty";
  console.log(obj[dynHop]("a"), obj["toString"]()); // true [object Object]

  // ----- .apply and .bind -----
  console.log((Array.prototype.slice.apply([1, 2, 3, 4], [1, 3]) as any).join(",")); // 2,3
  const bound: any = Array.prototype.slice.bind([5, 6, 7, 8]);
  console.log(bound(2).join(",")); // 7,8

  // ----- passed through a higher-order use -----
  const rows: any = [[1, 2, 3], [4, 5, 6]];
  const firsts = rows.map((r: number[]) => Array.prototype.slice.call(r, 0, 1)[0]);
  console.log(firsts.join(",")); // 1,4

  // ----- Function.prototype.{call,apply,bind} as values (method-borrow) -----
  console.log(typeof Function.prototype.call, typeof Function.prototype.apply, typeof Function.prototype.bind); // function function function
  const inc = (x: number) => x + 1;
  const callV: any = Function.prototype.call;
  console.log(callV.call(inc, null, 41)); // 42  (== inc.call(null, 41))
  const applyV: any = Function.prototype.apply;
  console.log(applyV.call(inc, null, [41])); // 42  (== inc.apply(null, [41]))
  const bindV: any = Function.prototype.bind;
  const incBound: any = bindV.call(inc, null); // == inc.bind(null)
  console.log(incBound(41)); // 42
  // the classic uncurried double-.call
  const add = (a: number, b: number) => a + b;
  console.log(Function.prototype.call.call(add, null, 2, 3)); // 5

  // ----- regression: direct instance calls unchanged (fast static path) -----
  console.log([1, 2, 3].slice(1).join(","), "hi".toUpperCase()); // 2,3 HI
}

main();
