// Element access of receivers typed as views (docs/typed_arrays_design.md,
// TA2): the in-line loads and stores, their bounds, the element conversions,
// and every receiver the static type does not describe (another element type,
// an array, an object, a view with an own `length`), which takes the generic
// path.
function sum(a: Int32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}
function fill(a: Float64Array, v: number): void {
  for (let i = 0; i < a.length; i++) a[i] = v + i;
}
function read(a: Uint8Array, i: number): number { return a[i]; }
// an index out of range reads undefined: kept by a destination that is not a
// number (a number-typed read of a missing element is NaN in typed mode, as
// for arrays)
function readAny(a: Uint8Array, i: number): unknown { const x: unknown = a[i]; return x; }
function write(a: Int16Array, i: number, v: number): void { a[i] = v; }
function bump(a: Uint32Array, i: number): void { a[i] += 1; a[i]++; ++a[i]; a[i] -= 4; a[i] |= 8; }
function boxed(a: Int8Array, i: number): unknown { const x: unknown = a[i]; return x; }

const i32 = Int32Array.from([1, 2, 3, 4]);
console.log(sum(i32), sum(new Int32Array(0)), sum(i32.subarray(1, 3)));
const f64 = new Float64Array(3);
fill(f64, 0.5);
console.log(f64.join(), sum(new Int32Array(f64)));

// bounds and keys
const u8 = new Uint8Array([10, 20, 30]);
for (const i of [0, 2, -0]) console.log("read", i, read(u8, i));
for (const i of [0, 2, 3, -1, 1.5, NaN, 2 ** 32, -0]) console.log("readAny", i, readAny(u8, i));
const i16 = new Int16Array(2);
for (const [i, v] of [[0, 40000], [1, -1.9], [2, 7], [-1, 7], [0.5, 7], [1, NaN], [0, Infinity]] as [number, number][]) {
  write(i16, i, v);
  console.log("write", i, v, i16.join(), (i16 as any)[i]);
}
console.log(boxed(new Int8Array([5]), 0), boxed(new Int8Array([5]), 3));

// conversions through the in-line store
function store<T extends { [k: number]: number; length: number }>(a: T, vals: number[]): string {
  for (let i = 0; i < vals.length; i++) a[i] = vals[i];
  const out: number[] = [];
  for (let i = 0; i < vals.length; i++) out.push(a[i]);
  return out.join();
}
const vals = [1.5, -1.5, 255.5, 256, -0, NaN, 2 ** 32 + 3, -(2 ** 31) - 1];
function u8c(a: Uint8ClampedArray, vs: number[]): string { for (let i = 0; i < vs.length; i++) a[i] = vs[i]; return a.join(); }
function f32(a: Float32Array, vs: number[]): string { for (let i = 0; i < vs.length; i++) a[i] = vs[i]; return a.join(); }
function u32(a: Uint32Array, vs: number[]): string { for (let i = 0; i < vs.length; i++) a[i] = vs[i]; return a.join(); }
function i8(a: Int8Array, vs: number[]): string { for (let i = 0; i < vs.length; i++) a[i] = vs[i]; return a.join(); }
console.log(u8c(new Uint8ClampedArray(8), vals));
console.log(f32(new Float32Array(8), [0.1, 16777217, 1e40, -1e-50, ...vals.slice(0, 4)]));
console.log(u32(new Uint32Array(8), vals));
console.log(i8(new Int8Array(8), vals));
console.log(store(new Uint16Array(8), vals));

// compound updates
const w = new Uint32Array([4294967295, 5]);
bump(w, 0); bump(w, 1); bump(w, 2);
console.log(w.join());

// receivers the static type does not describe: another element type, an
// array, an object with index keys (read and written as properties)
const lies: unknown[] = [new Float64Array([1.5, 2.5]), [1.5, 2.5], { 0: 1.5, 1: 2.5, length: 2 }, new Uint8Array([200, 100])];
for (const x of lies) {
  const a = x as Int32Array;
  console.log("sum", sum(a), "read", read(x as Uint8Array, 1), "len", a.length);
  write(x as Int16Array, 0, 70000);
  console.log("after write", (x as any)[0]);
}
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
report("null read", () => read(null as unknown as Uint8Array, 0));
report("undefined write", () => write(undefined as unknown as Int16Array, 0, 1));
report("number write", () => write(5 as unknown as Int16Array, 0, 1));
report("string write", () => write("abc" as unknown as Int16Array, 1, 1));
report("getter", () => { const o = {}; Object.defineProperty(o, 0, { get() { return 42; } }); return read(o as Uint8Array, 0); });
const own = new Int32Array([1, 2, 3]);
Object.defineProperty(own, "length", { value: 1 });
console.log("own length", own.length, sum(own));

// a loop that allocates while it holds a view (the slow paths link the frame)
function churn(a: Float64Array): number {
  let t = 0;
  for (let i = 0; i < a.length + 2; i++) {
    const o = { v: a[i] };
    t += o.v === undefined || Number.isNaN(o.v) ? 100 : o.v;
    a[i] = t;
  }
  return t;
}
console.log(churn(new Float64Array([1, 2, 3])));
