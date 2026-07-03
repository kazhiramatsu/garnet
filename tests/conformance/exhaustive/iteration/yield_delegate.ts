// `yield*` delegates to a built-in iterable (array / string / Map / Set), yielding
// each element to the caller. These built-ins have no runtime iterator object for
// the generic iterator driver, so the exporter walks them with an index loop (the
// same machinery for-of uses; Map/Set materialize to an array first). The value of
// the yield* expression is the inner iterator's return value = undefined for these.
function* arr() { yield* [1, 2, 3]; }
function* str() { yield* "ab"; }
function* strWide() { yield* "A😀B"; }
function* mixed() { yield 0; yield* [1, 2]; yield 3; }
function* empt() { yield 1; yield* []; yield 2; }
function* fromVar() { const a = [4, 5, 6]; yield* a; }
function* mapGen() { yield* new Map<string, number>([["x", 1], ["y", 2]]); }
function* setGen() { yield* new Set<number>([1, 2, 2, 3]); }
function* tupleGen() { yield* [1, "a", true]; }
function* inner() { yield* [20, 30]; }
function* nested() { yield 10; yield* inner(); yield 40; }
function* twice() { yield* [1, 2]; yield* [3, 4]; }
function* inLoop() { for (let k = 0; k < 3; k++) yield* [k, k * 10]; }
function* retval() { const r = yield* [1, 2]; return r; }
async function* aArr() { yield* [7, 8, 9]; }

async function main(): Promise<void> {
  console.log([...arr()].join(","));            // 1,2,3
  console.log([...str()].join(","));            // a,b
  console.log([...strWide()].map((x) => x + ":" + x.length).join("|")); // A:1|😀:2|B:1
  console.log([...mixed()].join(","));          // 0,1,2,3
  console.log([...empt()].join(","));           // 1,2
  console.log([...fromVar()].join(","));        // 4,5,6
  console.log([...setGen()].join(","));         // 1,2,3  (Set dedups)
  console.log([...tupleGen()].map((x) => String(x)).join(",")); // 1,a,true
  console.log([...nested()].join(","));         // 10,20,30,40
  console.log([...twice()].join(","));          // 1,2,3,4
  console.log([...inLoop()].join(","));         // 0,0,1,10,2,20

  // Map's default iterator yields [key, value] entries (read by index).
  for (const e of mapGen()) console.log(e[0] + "=" + String(e[1])); // x=1 / y=2

  // yield* over a built-in iterator returns undefined.
  const it = retval(); it.next(); it.next();
  console.log(String(it.next().value));         // undefined

  // sent values are ignored by built-in iterators.
  const it2 = arr();
  console.log(it2.next().value, it2.next(99).value); // 1 2

  // early break: the consumer simply stops pulling.
  let s = 0;
  for (const x of arr()) { if (x > 2) break; s += x; }
  console.log(s);                               // 3

  // an async generator may delegate to a sync array.
  const out: number[] = [];
  for await (const x of aArr()) out.push(x);
  console.log(out.join(","));                   // 7,8,9
}
main();
