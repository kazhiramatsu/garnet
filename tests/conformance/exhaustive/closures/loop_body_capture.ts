// A `const`/`let` declared in a loop BODY (not just the loop head) and captured
// by a closure must get a FRESH cell each iteration (JS §14.7.4 CreatePer-
// IterationEnvironment applies to the whole body). Previously the capture cell
// was pre-allocated once in the function prologue and shared across iterations,
// so escaping closures from different iterations aliased one cell. The sharpest
// symptom was a self-referential closure — `const prev = acc; acc = () =>
// prev(...)` — whose `prev` cell got overwritten with the closure itself,
// turning a later call into infinite recursion (stack-overflow SIGSEGV). Every
// loop kind (for-c, while, do-while, for-of, for-in) now reallocates body-
// declared captured cells per iteration.
function main(): void {
  // for-c: body-const captured and escaping (the classic squared-index case)
  const a: (() => number)[] = [];
  for (let i = 0; i < 4; i++) { const k = i * i; a.push(() => k); }
  console.log(a.map((f) => f()).join(",")); // 0,1,4,9

  // for-c: self-referential compose (the crash repro) — acc(100) = 100+0+1+2 = 103
  let acc = (x: number): number => x;
  for (let i = 0; i < 3; i++) { const prev = acc; const k = i; acc = (x: number) => prev(x) + k; }
  console.log(acc(100)); // 103

  // while: same compose
  let wacc = (x: number): number => x;
  let wi = 0;
  while (wi < 3) { const prev = wacc; const k = wi; wacc = (x: number) => prev(x) + k; wi++; }
  console.log(wacc(10)); // 13

  // do-while: same compose
  let dacc = (x: number): number => x;
  let di = 0;
  do { const prev = dacc; const k = di; dacc = (x: number) => prev(x) + k; di++; } while (di < 3);
  console.log(dacc(10)); // 13

  // for-of: body-const captured over an array of values
  let facc = (x: number): number => x;
  for (const step of [1, 10, 100]) { const prev = facc; const s = step; facc = (x: number) => prev(x) + s; }
  console.log(facc(0)); // 111

  // for-of: body-const escaping into a list
  const fo: (() => string)[] = [];
  for (const name of ["a", "b", "c"]) { const tag = name + "!"; fo.push(() => tag); }
  console.log(fo.map((f) => f()).join(",")); // a!,b!,c!

  // for-in: body-const captured per key
  const obj: any = { x: 1, y: 2, z: 3 };
  const fi: (() => string)[] = [];
  for (const key in obj) { const label = key + "=" + obj[key]; fi.push(() => label); }
  console.log(fi.map((f) => f()).join(",")); // x=1,y=2,z=3

  // nested loops: inner body-const must be fresh per INNER iteration
  const nn: (() => number)[] = [];
  for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { const v = i * 10 + j; nn.push(() => v); } }
  console.log(nn.map((f) => f()).join(",")); // 0,1,10,11

  // captured body-const used within the same iteration (no escape) still fine
  let within = 0;
  for (let i = 0; i < 3; i++) { const k = i + 1; const f = () => k; within += f(); }
  console.log(within); // 6

  // body-const in a nested (non-loop) block, captured, escaping — fresh per iter
  const nb: (() => number)[] = [];
  for (let i = 0; i < 3; i++) { if (i % 2 === 0) { const k = i; nb.push(() => k); } }
  console.log(nb.map((f) => f()).join(",")); // 0,2
}
main();
