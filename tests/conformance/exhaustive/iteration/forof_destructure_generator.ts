// for-of / for-await over a generator or custom iterable must destructure each
// yielded value into the loop pattern. The generic iterator-driven loop
// (lowerDrivenForLoop) used to bind the whole value to a throwaway temp and never
// unpack the pattern, so `for (const [a,b] of g())` left a,b unset (0/undefined);
// only the array/Map fast path unpacked. Covers array/object/nested/default/rest/
// hole/rename patterns over a generator, a custom iterable, and an async generator.
function* pairs() { yield [1, 2]; yield [3, 4]; }
function* objs() { yield { x: 1, y: 2 }; yield { x: 3, y: 4 }; }
function* nested() { yield [1, [2, 3]]; }
function* defs() { yield [1]; yield [2, 9]; }
function* rests() { yield [1, 2, 3, 4]; }
function* holes() { yield [1, 2, 3]; }
function* single() { yield { p: 5 }; }
const customIter = { *[Symbol.iterator]() { yield [10, 20]; yield [30, 40]; } };
async function* asyncPairs() { yield [5, 6]; yield [7, 8]; }

async function main(): Promise<void> {
  for (const [a, b] of pairs()) console.log(a, b);              // 1 2 / 3 4
  for (const { x, y } of objs()) console.log(x, y);             // 1 2 / 3 4
  for (const [a, [b, c]] of nested()) console.log(a, b, c);     // 1 2 3
  for (const [a, b = 99] of defs()) console.log(a, b);          // 1 99 / 2 9
  for (const [a, ...rest] of rests()) console.log(a, rest.join("-")); // 1 2-3-4
  for (const [, b] of holes()) console.log(b);                  // 2
  for (const { p: q, r = 7 } of single()) console.log(q, r);    // 5 7  (rename + default)
  for (const [a, b] of customIter) console.log(a, b);           // 10 20 / 30 40

  // bindings drive logic (not just printing)
  let sum = 0;
  for (const [a, b] of pairs()) sum += a * b;
  console.log(sum);                                              // 1*2 + 3*4 = 14

  // async generator (for await) destructuring
  for await (const [a, b] of asyncPairs()) console.log(a + b);   // 11 / 15
}
main();
