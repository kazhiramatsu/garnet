// Proven ranges (docs/typed_array_loops_design.md "Proven ranges"): a counted loop proves at
// its entry that an inner prefix loop's indices, affine in its induction locals, stay within
// their views for the whole loop, and that inner loop skips its clamps. Each shape also runs
// where the proof must fail (a view too short, a negative start, a shift that wraps, an offset
// read before its definition, a conditional increment, an induction local assigned in the
// body), where the generic path reads undefined.
function q8(q: Int8Array, x: Int8Array, scales: Float32Array, rows: number, nb: number): number {
  let total = 0;
  const rowBytes = nb * 34;
  for (let r = 0; r < rows; r++) {
    let s = 0;
    let p = Math.imul(r, rowBytes);
    const sb = Math.imul(r, nb);
    for (let b = 0; b < nb; b++) {
      const xb = b << 5, qb = p + 2;
      let isum = 0;
      for (let j = 0; j < 32; j++) isum = (isum + ((q[qb + j] << 24) >> 24) * ((x[xb + j] << 24) >> 24)) | 0;
      s += scales[sb + b] * isum;
      p += 34;
    }
    total += s;
  }
  return total;
}
function fill(n: number, seed: number): Int8Array {
  const a = new Int8Array(n);
  let h = seed;
  for (let i = 0; i < n; i++) { h = (Math.imul(h, 1103515245) + 12345) | 0; a[i] = (h >> 16) & 255; }
  return a;
}
function sweep(a: Float64Array, start: number, step: number, count: number, inner: number): number {
  // a derived induction local from `start` (negative, or running past the view) with a step
  let s = 0;
  let base = start;
  for (let k = 0; k < count; k++) {
    const off = base + 1;
    for (let i = 0; i < inner; i++) { const v = a[off + i]; s += v === undefined ? 1000 : v; }
    base += step;
  }
  return s;
}
function shifted(a: Uint8Array, b0: number, nb: number): number {
  // `b << 5` wraps once b reaches 2^26: the proof fails there (the shift's own condition)
  let s = 0;
  for (let b = b0; b < nb; b++) {
    const xb = b << 5;
    for (let j = 0; j < 4; j++) { const v = a[xb + j]; s += v === undefined ? 1 : v + 2; }
  }
  return s;
}
function late(a: Int32Array, n: number): number {
  // the offset is read by the inner loop before its definition in the iteration (the previous
  // iteration's value, 1e9 at first): not proven, the generic path reads undefined
  let s = 0, off = 1000000000;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 2; i++) { const v = a[off + i]; s += v === undefined ? 7 : v; }
    off = k * 2;
  }
  return s;
}
function conditional(a: Int16Array, n: number): number {
  // a derived induction local incremented under a condition: not recognized, the clamps stay
  let s = 0, p = 0;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 3; i++) { const v = a[p + i]; s += v === undefined ? 100 : v; }
    if ((k & 1) === 0) p += 3;
  }
  return s;
}
function broken(a: Int16Array, n: number): number {
  // the induction local assigned in the body: not a counted loop, nothing proven
  let s = 0;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < 2; i++) { const v = a[k * 2 + i]; s += v === undefined ? 10 : v; }
    if (k === 2) k = n - 2;
  }
  return s;
}
function stepped(a: Float32Array, n: number): number {
  // the outer loop steps by 3 from 1, the inner by 2; the index is 4 * k + 2 * i + 1
  let s = 0;
  for (let k = 1; k < n; k += 3) {
    const base = k * 4 + 1;
    for (let i = 0; i < 4; i += 2) { const v = a[base + i]; s += v === undefined ? 0.5 : v; }
  }
  return s;
}
function directs(x: Float32Array, sc: Float32Array, acc: Float32Array, nb: number): number {
  // direct accesses in the counted loop's body: x[b] and sc[sb + b] read, acc[b] stored (a store
  // beyond the length is the no-op of the generic path, a read beyond it undefined)
  let s = 0;
  const sb = nb * 2;
  for (let b = 0; b < nb; b++) {
    const v = x[b], w = sc[sb + b];
    acc[b] = v + w;
    s += v === undefined ? 1000 : v * (w === undefined ? -1 : w);
  }
  return s + acc.length;
}
function breaks(x: Float32Array, n: number): number {
  // `continue` and `break` inside a versioned loop (the proven copy and the generic one)
  let s = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 3) === 1) continue;
    const v = x[i];
    if (v > 10) break;
    s += v === undefined ? 50 : v;
  }
  return s;
}
function main(): void {
  const rows = 6, nb = 4;
  const q = fill(rows * nb * 34 + 2, 7), x = fill(nb * 32, 11);
  const scales = new Float32Array(rows * nb);
  for (let i = 0; i < scales.length; i++) scales[i] = 0.5 + (i % 3);
  console.log(q8(q, x, scales, rows, nb), q8(q, x, scales, rows + 1, nb), q8(q.subarray(0, 100), x, scales, rows, nb), q8(q, x.subarray(0, 40), scales, rows, nb));
  const a = new Float64Array(16);
  for (let i = 0; i < 16; i++) a[i] = i * 1.5;
  console.log(sweep(a, 0, 4, 3, 4), sweep(a, -3, 4, 3, 4), sweep(a, 2, 5, 3, 4), sweep(a, 0, 4, 0, 4), sweep(a, 0, 4, 3, 0), sweep(a, 0, 1, 20, 2), sweep(a, 0, -1, 3, 2));
  const u = new Uint8Array(64);
  for (let i = 0; i < 64; i++) u[i] = i;
  console.log(shifted(u, 0, 2), shifted(u, 1, 2), shifted(u, 67108862, 67108866), shifted(u, 67108863, 67108864), shifted(u, -1, 1));
  const i32 = new Int32Array(8);
  for (let i = 0; i < 8; i++) i32[i] = i * 10;
  console.log(late(i32, 3), late(i32, 0));
  const i16 = new Int16Array(6);
  for (let i = 0; i < 6; i++) i16[i] = i + 1;
  console.log(conditional(i16, 4), conditional(i16, 8), broken(i16, 6));
  const f = new Float32Array(30);
  for (let i = 0; i < 30; i++) f[i] = i;
  console.log(stepped(f, 7), stepped(f, 10), stepped(f, 0));
  const xf = new Float32Array(8), scf = new Float32Array(24), accf = new Float32Array(8);
  for (let i = 0; i < 8; i++) xf[i] = i + 0.5;
  for (let i = 0; i < 24; i++) scf[i] = i * 0.25;
  console.log(directs(xf, scf, accf, 8), accf.join(","), directs(xf, scf.subarray(0, 20), accf, 8), directs(xf.subarray(0, 4), scf, new Float32Array(3), 8));
  const big = new Float32Array(8);
  for (let i = 0; i < 8; i++) big[i] = i === 5 ? 11 : i;
  console.log(breaks(xf, 8), breaks(xf, 12), breaks(big, 8), breaks(big, 3));
}
main();
