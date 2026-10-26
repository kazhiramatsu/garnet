// Nested loops over typed arrays: the inner loop reuses the enclosing loop's hoisted view
// (handle, length, data pointer) when the same local is viewed with the same element kind and
// is not assigned in the enclosing loop; a local reassigned between the inner loops hoists
// anew; a value that is not a typed array at the outer loop's entry takes the generic path;
// an index beyond the length reads undefined.
function dotRows(w: Int8Array, x: Int8Array, rows: number, cols: number): number {
  let total = 0;
  for (let r = 0; r < rows; r++) {
    const off = r * cols;
    let isum = 0;
    for (let i = 0; i < cols; i++) isum = (isum + w[off + i] * x[i]) | 0;
    total += isum;
  }
  return total;
}
function sweep(a: Float64Array, n: number): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < n; i++) a[i] = a[i] * 0.5 + i;
    for (let i = 0; i < n; i++) s += a[i];
    for (let i = n; i < n + 2; i++) s += a[i] === undefined ? 1000 : 0;
  }
  return s;
}
function reassigned(n: number): number {
  let v = new Float64Array(n);
  let s = 0;
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < n; i++) v[i] = i + k;
    v = new Float64Array(n + 1);
    for (let i = 0; i < v.length; i++) s += v[i] + i;
  }
  return s + v.length;
}
function notTyped(xs: any, n: number): number {
  let s = 0;
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < n; i++) s += xs[i];
  }
  return s;
}
function main(): void {
  const w = new Int8Array(64), x = new Int8Array(8);
  for (let i = 0; i < 64; i++) w[i] = ((i * 37) % 23) - 11;
  for (let i = 0; i < 8; i++) x[i] = i - 3;
  console.log(dotRows(w, x, 8, 8));
  const a = new Float64Array(6);
  console.log(sweep(a, 6));
  console.log(reassigned(5));
  console.log(notTyped([1, 2, 3, 4], 4), notTyped(new Float32Array([1.5, 2.5, 3.5, 4.5]), 4));
  // three levels: the innermost reuses the outermost's hoist
  const m = new Uint16Array(27);
  let acc = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) { m[i * 9 + j * 3 + k] = i + j + k; acc += m[i * 9 + j * 3 + k]; }
  console.log(acc, m.join(","));
}
main();
