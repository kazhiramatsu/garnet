// Typed-array receivers in loops: a receiver the loop never assigns, one it
// reassigns, one that is not a view at run time, one swapped through a
// closure, nested loops over two views, stores past the end, and the length
// read in the loop condition.
function sumInvariant(a: Uint16Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s = (s + (a[i] | 0)) | 0;
  return s;
}
function sumReassigned(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  let v = a;
  for (let i = 0; i < 6; i++) {
    s = (s + (v[i] | 0)) | 0;
    v = i % 2 === 0 ? b : a;
  }
  return s;
}
function sumAny(a: Int32Array): number {
  let s = 0;
  for (let i = 0; i < 5; i++) s = (s + (a[i] | 0)) | 0;
  return s;
}
function viaClosure(): number {
  let cur = new Int16Array([1, 2, 3, 4]);
  const swap = () => { cur = new Int16Array([10, 20, 30, 40]); };
  let s = 0;
  for (let i = 0; i < 4; i++) {
    s = (s + (cur[i] | 0)) | 0;
    if (i === 1) swap();
  }
  return s;
}
function nested(a: Uint8Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) s += a[i] * b[j];
    s += a[i + 100] === undefined ? 1 : 0;
  }
  return s;
}
function storesPastEnd(a: Uint8ClampedArray): string {
  for (let i = 0; i < 12; i++) a[i] = i * 40 - 20;
  return Array.from(a).join(",") + "|" + a.length;
}
function whileLength(a: Uint32Array): number {
  let i = 0, s = 0;
  while (i < a.length) { s = (s + (a[i] | 0)) | 0; i = (i + 1) | 0; }
  return s;
}
function main() {
  const u16 = new Uint16Array([1, 65535, 300, 7]);
  const u8a = new Uint8Array([1, 2, 3, 4, 5, 6]), u8b = new Uint8Array([10, 20, 30, 40, 50, 60]);
  const out: unknown[] = [sumInvariant(u16), sumReassigned(u8a, u8b), viaClosure()];
  out.push(sumAny(new Int32Array([5, -5, 2147483647, -2147483648, 9])));
  out.push(sumAny([1, 2, 3] as unknown as Int32Array), sumAny({ 0: 7, 1: "8", length: 2 } as unknown as Int32Array));
  out.push(nested(u8a, new Float64Array([0.5, 1.5])), storesPastEnd(new Uint8ClampedArray(8)), whileLength(new Uint32Array([4294967295, 1, 2])));
  out.push(sumInvariant(new Uint16Array(0)), sumInvariant(u16.subarray(1, 3)));
  console.log(JSON.stringify(out));
}
main();
