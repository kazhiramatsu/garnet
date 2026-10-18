const values = new Uint16Array(5);
console.log(values.length, Array.isArray(values), Array.from(values).join(","));
values[0] = -1;
values[1] = 65536 + 7;
values[2] = 1.9;
values[3] = NaN;
values[4] = Infinity;
values[8] = 7;
console.log(values.length, Array.from(values).join(","), values[8]);
const copy = new Uint16Array(values);
values[0] = 2;
console.log(copy[0], values[0], copy.join(":"), copy.toString());
console.log(new Uint16Array([65537, -2, 3.9]).join(","));
let sum = 0;
for (const value of copy) sum += value;
console.log(sum, Object.prototype.toString.call(copy), JSON.stringify(copy));
console.log(copy.byteLength, copy.byteOffset, copy.BYTES_PER_ELEMENT);
let fractional = 1.5;
copy[fractional] = 99;
console.log(copy[fractional], copy[1]);
for (const length of [-1, Infinity]) {
  try { new Uint16Array(length); }
  catch (error) { console.log(error instanceof RangeError); }
}
