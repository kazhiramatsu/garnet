// Capture contexts: a function's captured bindings live in one scope record
// per activation (loop-scoped bindings keep per-iteration cells), closures and
// nested functions capture the record. This fixture exercises reads/writes
// through records at several nesting depths, per-iteration bindings next to
// record bindings, uninitialized record bindings (`let x;` must read as
// undefined), captured parameters and `this`, named function expressions, and
// module-level bindings captured by functions and methods.

let moduleCount = 0;
let moduleLate: string | undefined;
function bumpModule(): number { moduleCount += 2; return moduleCount; }
class Reader { read(): string { moduleLate ??= "set-by-method"; return moduleLate + moduleCount; } }
// A method reads the module record on one control-flow path and then again
// after the branch: every use must load the record anew (a load emitted inside
// the branch is not available on the other path).
class Paths {
  m(flag: boolean): number { if (flag) { moduleCount++; } return moduleCount; }
  n(flag: boolean): string { if (!flag) { return "none:" + moduleCount; } moduleLate ??= "nm"; return moduleLate + moduleCount; }
}

function counter(start: number) {
  let n = start;
  let log = "";
  function inc() { n++; log += "i"; return n; }
  function get() { return n; }
  const reset = (v: number) => { n = v; log += "r"; };
  return { inc, get, reset, log: () => log };
}
function nested(a: number) {
  let b = a * 2;
  function mid(c: number) {
    let d = b + c;
    function inner() { return a + b + c + d; }
    b++;
    return inner;
  }
  return mid;
}
function loops(): string[] {
  const fns: (() => string)[] = [];
  let outer = 0;
  for (let i = 0; i < 3; i++) {
    const tag = "t" + i;
    outer += i;
    fns.push(() => tag + ":" + i + ":" + outer);
  }
  for (const w of ["x", "y"]) fns.push(() => w + outer);
  return fns.map((f) => f());
}
function uninit() {
  let late: string | undefined;
  var v: number | undefined;
  function set() { late ??= "L"; v ??= 7; }
  const before = [late, v];
  set();
  return [before, late, v];
}
class K {
  constructor(public x: number) {}
  make(): () => number { const self = this; let k = this.x; return () => self.x + k++; }
}
function deep(a: number) {
  let b = a + 1;
  return function l1(c: number) {
    let d = b + c;
    return function l2(e: number) {
      let f = d + e;
      return () => { b++; d++; f++; return [a, b, c, d, e, f].join("/"); };
    };
  };
}
function generatorCapture(): number[] {
  let acc = 0;
  function* g() { for (let i = 1; i <= 3; i++) { acc += i; yield acc; } }
  const out: number[] = [];
  for (const v of g()) out.push(v);
  out.push(acc);
  return out;
}
async function asyncCapture(): Promise<string> {
  let s = "a";
  const add = async (t: string) => { s += t; await Promise.resolve(); s += t.toUpperCase(); };
  await add("b");
  await add("c");
  return s;
}
function main(): void {
  const c = counter(5);
  console.log(c.inc(), c.inc(), c.get(), c.reset(1), c.get(), c.log());
  const m = nested(1);
  const f1 = m(10); const f2 = m(20);
  console.log(f1(), f2());
  console.log(loops().join(","));
  console.log(JSON.stringify(uninit()));
  const kf = new K(3).make();
  console.log(kf(), kf());
  const named = function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); };
  console.log(named(5));
  const g = deep(1)(10)(100);
  console.log(g(), g());
  console.log(generatorCapture().join(","));
  console.log(bumpModule(), bumpModule(), moduleLate, new Reader().read(), moduleCount);
  const pth = new Paths();
  console.log(pth.m(false), pth.m(true), pth.n(false), pth.n(true), pth.n(false));
  asyncCapture().then((s) => console.log(s));
}
main();
