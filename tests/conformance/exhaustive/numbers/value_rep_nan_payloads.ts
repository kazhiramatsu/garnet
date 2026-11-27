// Doubles whose bits a value representation could take for something else (docs/unmasked_pointers_design.md):
// NaNs of either sign with every kind of payload, among them the bits of each selector of representation 0
// under a NaN, and denormals with the bits of addresses. Each read out of a Float64Array is a number: kept in
// an any, an array, a Map (as a key and as a value), a class's boxed and number fields, compared, printed and
// written back.
function f64(hi: number, lo: number): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setUint32(0, lo >>> 0, true);
  dv.setUint32(4, hi >>> 0, true);
  return dv.getFloat64(0, true);
}
class Box { v: any; w: number; constructor(v: any, w: number) { this.v = v; this.w = w; } }
function main(): void {
  const pats: [number, number][] = [
    [0xFFF80000, 0], [0xFFFFFFFF, 0xFFFFFFFF], [0x7FF80000, 1], [0x7FF00000, 1], [0xFFF00000, 1],
    [0xFFF90000, 0x1000], [0xFFFA0000, 0x2000], [0xFFFB0000, 1], [0xFFFC0000, 0], [0xFFFD0000, 0],
    [0xFFFE0000, 0x41424344], [0x7FFFFFFF, 0xFFFFFFFF],
    [0x00000001, 0x00004000], [0x00007FFF, 0x12345670], [0x0000FFFF, 0xFFFFFFF0], [0x80000001, 0x00004000],
  ];
  const ta = new Float64Array(pats.length);
  for (let i = 0; i < pats.length; i++) ta[i] = f64(pats[i][0], pats[i][1]);
  const arr: number[] = [];
  const m = new Map<number, number>();
  const anys: any[] = [];
  const boxes: Box[] = [];
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i];
    arr.push(x); m.set(x, i); anys.push(x as any); boxes.push(new Box(x, x));
  }
  for (let i = 0; i < ta.length; i++) {
    const x = arr[i], a = anys[i], b = boxes[i];
    console.log(i, Number.isNaN(x), x === x, typeof a, Number.isNaN(a), Object.is(b.v, x), b.w === x,
                m.get(x), x > 0, x < 0, String(a).slice(0, 12));
  }
  console.log(m.size, [...m.values()].join(","));
  const back = new Float64Array(arr);
  let nans = 0;
  for (let i = 0; i < back.length; i++) if (Number.isNaN(back[i])) nans++;
  console.log(nans, back.length);
  console.log(JSON.stringify(arr.slice(12)), arr.slice(12).map((d) => d * 2 ** 1074).join(","));
}
main();
