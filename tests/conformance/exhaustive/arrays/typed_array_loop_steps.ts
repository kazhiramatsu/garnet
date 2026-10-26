// Typed-array loops with a constant step (`i += 2`, `i += 4`) and offset indices below the step
// (docs/typed_array_loops_design.md): the unrolled dot product with four partial sums (a fixed
// order of additions, the same values under Node), a stride-2 complex rotation, a remainder loop,
// steps that do not divide the length (the general loop finishes the tail), a step larger than
// the length, int8 and float32 views, and a loop whose step is not a constant (not taken).
function dot4(w: Float32Array, wOff: number, x: Float32Array, n: number): number {
  const n4 = n & ~3;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let j = 0; j < n4; j += 4) {
    s0 += w[wOff + j] * x[j];
    s1 += w[wOff + j + 1] * x[j + 1];
    s2 += w[wOff + j + 2] * x[j + 2];
    s3 += w[wOff + j + 3] * x[j + 3];
  }
  let s = (s0 + s1) + (s2 + s3);
  for (let j = n4; j < n; j++) s += w[wOff + j] * x[j];
  return s;
}
function rotate(v: Float32Array, off: number, n: number, c: number, s: number): void {
  for (let i = 0; i < n; i += 2) {
    const a = v[off + i], b = v[off + i + 1];
    v[off + i] = a * c - b * s;
    v[off + i + 1] = a * s + b * c;
  }
}
function sumStep(a: Float64Array, step: number, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i += step) s += a[i];   // the step is a local: the general loop
  return s;
}
function sumEvery3(a: Int8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += a[i] + a[i + 1];
  return s;
}
function main(): void {
  const w = new Float32Array(32), x = new Float32Array(16);
  for (let i = 0; i < 32; i++) w[i] = Math.sin(i) * 0.5;
  for (let i = 0; i < 16; i++) x[i] = Math.cos(i * 0.3);
  console.log(dot4(w, 0, x, 16), dot4(w, 16, x, 16), dot4(w, 16, x, 13), dot4(w, 20, x, 16), dot4(w, 0, x, 3), dot4(w, 0, x, 0), dot4(w, 2.5, x, 8), dot4(w, -4, x, 8));
  const v = new Float32Array([1, 0, 0, 1, 2, 3, 4, 5, 6]);
  rotate(v, 0, 8, 0.6, 0.8); console.log(v.join(","));
  rotate(v, 1, 8, 0.6, 0.8); console.log(v.join(","));
  rotate(v, 4, 9, 0, 1); console.log(v.join(","));
  rotate(v, 0, 2, 1, 0); console.log(v.join(","));
  const a = new Float64Array([1, 2, 3, 4, 5, 6, 7]);
  console.log(sumStep(a, 1, 7), sumStep(a, 2, 7), sumStep(a, 3, 7), sumStep(a, 10, 7), sumStep(a, 2, 9), sumStep(a, 2.5, 7));
  console.log(sumEvery3(new Int8Array([1, 2, 3, 4, 5, 6, 7, 8])), sumEvery3(new Int8Array([100, 100, 100, 100])), sumEvery3(new Int8Array(0)), sumEvery3(new Int8Array([1])));
}
main();
