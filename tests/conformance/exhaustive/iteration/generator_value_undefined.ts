// An exhausted iterator's `.value` is `undefined` even though TypeScript types it
// as the yield/return type (number); it must stay boxed, not unbox to NaN.
function* g(): Generator<number, number, unknown> { yield 1; yield 2; return 99; }
function* s(): Generator<string> { yield "a"; }
function main(): void {
  const it = g();
  console.log(it.next().value, it.next().value, it.next().value, it.next().value, it.next().value);
  const it2 = g();
  let r = it2.next();
  while (!r.done) { console.log(r.value); r = it2.next(); }
  console.log("done", r.value);
  const its = s();
  console.log(its.next().value, its.next().value);
}
main();
