// Element-wise typed-array loops (docs/typed_array_loops_design.md): fill, a scaled add, a byte
// transform, a copy between views, and a dot product (a double reduction stays scalar).
function fill(a: Float64Array): void { for (let i = 0; i < a.length; i++) a[i] = i * 0.5; }
function axpy(y: Float64Array, x: Float64Array, k: number): void { for (let i = 0; i < y.length; i++) y[i] = k * x[i] + y[i]; }
function bytes(b: Uint8Array, k: number): void { for (let i = 0; i < b.length; i++) b[i] = (b[i] + k) & 255; }
function copy(d: Int32Array, s: Int32Array): void { for (let i = 0; i < d.length; i++) d[i] = s[i]; }
function dot(a: Float64Array, b: Float64Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function main(): void {
  const n = 1 << 18;
  const a = new Float64Array(n), y = new Float64Array(n), b = new Uint8Array(n), s = new Int32Array(n), d = new Int32Array(n);
  for (let i = 0; i < n; i++) s[i] = i & 1023;
  let acc = 0;
  for (let r = 0; r < 300; r++) { fill(a); axpy(y, a, 0.001); bytes(b, r); copy(d, s); acc += dot(a, y) * 1e-9 + d[r & 1023] + b[r & 1023]; }
  console.log(Math.round(acc));
}
main();
