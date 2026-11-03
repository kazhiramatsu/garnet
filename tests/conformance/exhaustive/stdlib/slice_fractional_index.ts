// A relative index goes through ToIntegerOrInfinity first: a fraction above -1 is 0, not an offset from the end. The
// string and array `slice` took `length + (long)value`, the end of the receiver, for it (found by the features fuzzer).
function strings(i: number, j: number): void {
  const s = "hello";
  console.log(s.slice(i), s.slice(i, j), s.slice(j, i), s.substring(i), s.substring(i, j));
}
function arrays(i: number, j: number): void {
  const a = [10, 20, 30, 40, 50];
  console.log(a.slice(i), a.slice(i, j), a.slice(j, i));
}
const starts = [-0.5, -0.9, -0, 0.5, -1, -1.5, -2.9, 2.9, -100, 100, NaN, Infinity, -Infinity];
for (const i of starts) {
  strings(i, 3);
  strings(i, -0.5);
  arrays(i, 3);
  arrays(i, -0.5);
}
console.log("hello".slice(-0.5), "hello".slice(1, -0.5), [1, 2, 3].slice(-0.5), [1, 2, 3].slice(1, -0.9));
let v = 1;
let w = " 7 ";
for (let i = 0; i < 3; i++) {
  w = (v + w.slice(-0.5)).slice(0, 40);
  v += w.length;
}
console.log(w, v);
