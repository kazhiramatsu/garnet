// Strict and loose comparisons against undefined/null/boolean constants are
// bit compares of the boxed value; the result must match V8 for every kind of
// operand (numbers, NaN, -0, strings, objects, functions, booleans, nullish).
function show(label: string, v: unknown): void {
  console.log(label, v === undefined, v !== undefined, v === null, v !== null,
    v == null, v != null, v == undefined, v != undefined,
    v === true, v !== true, v === false, v !== false);
}
function main(): void {
  const vals: unknown[] = [undefined, null, true, false, 0, 1, -0, NaN, "", "x", "undefined", "null", [], {}, main, 0.5, 1e300];
  for (let i = 0; i < vals.length; i++) show("v" + i, vals[i]);
  // the constant on the left, parameters reassigned to undefined, catch vars
  function left(x: unknown): string {
    return (undefined === x ? "U" : "u") + (null !== x ? "N" : "n") + (true === x ? "T" : "t") + (false == x ? "F" : "f");
  }
  console.log(left(undefined), left(null), left(true), left(1), left(0), left(false));
  function reassigned(p?: number): boolean {
    const before = p === undefined;
    p = undefined;
    return before !== (p === undefined);
  }
  console.log(reassigned(1), reassigned());
  function caught(): boolean {
    let e: unknown = undefined;
    try { throw null; } catch (err) { e = err; }
    return e === null && e !== undefined && e == undefined;
  }
  console.log(caught());
  // conditionally assigned values compared in conditions
  let found: number | undefined;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    if (found === undefined && i * i > 20) found = i;
    if (found !== undefined) count++;
  }
  console.log(found, count);
  // optional properties and nullish fallbacks
  const o: { a?: number; b: number | null } = { b: null };
  console.log(o.a === undefined, o.b === null, o.a !== undefined ? o.a : -1, o.b != null ? o.b : -2);
  // a local that holds different constants over time is not a tag constant
  let k: unknown = undefined;
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += (vals[i] === k ? "=" : "/");
    k = i === 0 ? null : i === 1 ? true : false;
  }
  console.log(s);
  // the compares used as values keep their boolean type
  const r = [vals[0] === undefined, vals[4] !== null, vals[2] === true, vals[1] == undefined];
  console.log(r, typeof r[0]);
  // loose equality with booleans converts (1 == true), strict does not
  const one: unknown = 1;
  const empty: unknown = "";
  console.log(one == true, one === true, empty == false, empty === false);
}
main();
