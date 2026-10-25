// Counted loops over typed arrays (docs/typed_array_loops_design.md): element-wise loops over
// every element kind, views of different lengths (the prefix the fast loop covers and the
// remainder past a view's length), two overlapping views of one buffer, NaN/infinity/fractions
// stored into integer views, a loop starting above zero, a bound beyond every length, the loop
// variable read after the loop, an empty view, and a loop the rule leaves alone (a call).
function fill(a: Float64Array, k: number): void { for (let i = 0; i < a.length; i++) a[i] = i * k; }
function saxpy(y: Float32Array, x: Float32Array, a: number): void { for (let i = 0; i < y.length; i++) y[i] = a * x[i] + y[i]; }
function bytes(b: Uint8Array, k: number): void { for (let i = 0; i < b.length; i++) b[i] = (b[i] + k) & 255; }
function copyInto(dst: Int32Array, src: Int32Array): void { for (let i = 0; i < src.length; i++) dst[i] = src[i]; }
function sum(a: Float64Array, from: number): number { let s = 0; for (let i = from; i < a.length; i++) s += a[i]; return s; }
function maxU16(a: Uint16Array): number { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
function clampStore(c: Uint8ClampedArray, src: Float64Array): void { for (let i = 0; i < src.length; i++) c[i] = src[i]; }
function wrapStore(w: Int8Array, src: Float64Array): void { for (let i = 0; i < src.length; i++) w[i] = src[i]; }
function overlap(buf: ArrayBuffer): string { const a = new Int32Array(buf, 0, 8), b = new Int32Array(buf, 4, 8); for (let i = 0; i < a.length; i++) b[i] = a[i] + 1; return Array.from(new Int32Array(buf)).join(","); }
function beyond(a: Uint32Array, n: number): number { let last = -1; let i = 0; for (; i < n; i++) { a[i] = i * 3; last = i; } return i * 1000 + last + (a[a.length] === undefined ? 1 : 0); }
function withCall(a: Float64Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i]); return Math.round(s * 1000) / 1000; }
function main(): void {
  const a = new Float64Array(37); fill(a, 0.5);
  console.log(a[0], a[1], a[36], sum(a, 0), sum(a, 30), sum(a, 40), sum(a, -3));
  const x = new Float32Array(10), y = new Float32Array(10); fill2(x, y); saxpy(y, x, 2.5);
  console.log(Array.from(y).join(","));
  const b = new Uint8Array(300); for (let i = 0; i < b.length; i++) b[i] = i; bytes(b, 200); bytes(b, 3.7); console.log(b[0], b[55], b[255], b[299], b.length);
  const src = new Int32Array([1, -2, 3, 2147483647, -2147483648]), small = new Int32Array(3), big = new Int32Array(8);
  copyInto(small, src); copyInto(big, src); console.log(Array.from(small).join(","), Array.from(big).join(","));
  const u = new Uint16Array([5, 65535, 7, 0, 65534]); console.log(maxU16(u), maxU16(new Uint16Array(0)));
  const f = new Float64Array([1.5, -1.5, 255.5, 256, 300, -1, NaN, Infinity, -Infinity, 1e10, 2.5]);
  const c = new Uint8ClampedArray(f.length), w = new Int8Array(f.length); clampStore(c, f); wrapStore(w, f);
  console.log(Array.from(c).join(","), Array.from(w).join(","));
  const buf = new ArrayBuffer(48); const init = new Int32Array(buf); for (let i = 0; i < init.length; i++) init[i] = i * 10;
  console.log(overlap(buf));
  const z = new Uint32Array(6); console.log(beyond(z, 4), beyond(z, 9), Array.from(z).join(","), beyond(new Uint32Array(0), 2));
  console.log(withCall(new Float64Array([4, 9, 2])));
}
function fill2(x: Float32Array, y: Float32Array): void { for (let i = 0; i < x.length; i++) { x[i] = i / 4; y[i] = 100 - i; } }
main();
