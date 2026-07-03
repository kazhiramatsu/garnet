// generator.return(v) — forced early termination, and reading an iterator
// result's `.value` when done (which is `undefined`, not the yield type).
function* g(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
}

function main(): void {
  // .return(v) terminates: returns { value: v, done: true }, then exhausted.
  const a = g();
  console.log(a.next().value);        // 1
  const r = a.return(99);
  console.log(r.value, r.done);       // 99 true
  console.log(a.next().done);         // true

  // .return() with no argument -> value is undefined.
  const b = g();
  b.next();
  const rb = b.return();
  console.log(String(rb.value), rb.done); // undefined true

  // .return() before the generator has started.
  const c = g();
  const rc = c.return(5);
  console.log(rc.value, rc.done);     // 5 true
  console.log(c.next().done);         // true

  // .return() on an already-finished generator still reports the value.
  const d = g();
  d.next(); d.next(); d.next(); d.next();
  const rd = d.return(8);
  console.log(rd.value, rd.done);     // 8 true

  // reading `.value` of a result that is done must be undefined, not NaN
  // (the value field is typed `number | void` for this generator).
  const e = g();
  e.next(); e.next(); e.next();
  const re = e.next();
  console.log(String(re.value), re.done); // undefined true

  // early break out of for-of closes the generator cleanly.
  let sum = 0;
  for (const x of g()) {
    sum += x;
    if (x === 2) break;
  }
  console.log(sum);                   // 3
}

main();
