// Typed arrays and buffers (docs/typed_arrays_design.md): construction, element
// conversion, views over one buffer, the properties, tags and errors.
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}

// construction and element conversion
const i32 = new Int32Array(4);
i32[0] = 5; i32[1] = -7; i32[2] = 2147483648; i32[3] = 1.9;
console.log(i32[0], i32[1], i32[2], i32[3], i32.length, i32[4]);
console.log(new Int8Array([127, 128, -129, 255]).join());
console.log(new Uint8Array([1, 2, 300, -1]).join(), new Uint8Array(3).join());
console.log(Array.from(new Uint8ClampedArray([1.5, 2.5, 300, -1, 254.5, NaN])).join());
console.log(new Int16Array([40000, -40000]).join(), new Uint16Array([-1, 65537]).join());
console.log(new Uint32Array([-1, 4294967296, 1.5]).join());
const f32 = new Float32Array(2); f32[0] = 0.1; f32[1] = 16777217;
console.log(f32[0], f32[1]);
console.log(new Float64Array([1.5, -0, NaN, Infinity]).join());
const conv = new Int32Array(4);
const any0: any = conv;
any0[0] = "12"; any0[1] = true; any0[2] = null; any0[3] = { valueOf() { return 9; } };
console.log(conv.join());
console.log(new Int32Array(new Set([5, 6, 7])).join(), new Float64Array(new Int8Array([-1, 2])).join());
console.log(new Uint8Array({ length: 2, 0: 4, 1: 5 } as ArrayLike<number>).join());
console.log(new Int16Array().length, new Int16Array(undefined as unknown as number).length);

// buffers and views
const buf = new ArrayBuffer(8);
const words = new Uint32Array(buf);
const bytes = new Uint8Array(buf, 4, 4);
words[1] = 0x01020304;
console.log(bytes[0], bytes[1], bytes[2], bytes[3], buf.byteLength, bytes.byteOffset, bytes.byteLength);
console.log(bytes.buffer === buf, words.buffer === bytes.buffer);
bytes[0] = 0xff;
console.log(words[1].toString(16));
const sub = new Uint16Array(8).subarray(2, 5);
console.log(sub.length, sub.byteOffset, sub.byteLength, sub.buffer.byteLength);
const shared = new SharedArrayBuffer(8);
const counters = new Int32Array(shared);
counters[1] = 7;
console.log(counters[1], shared.byteLength, new Int32Array(shared, 4, 1)[0]);
console.log(new Uint8Array(new Uint8Array([1, 2, 3, 4]).buffer.slice(1, 3)).join());
console.log(new Uint8Array(new Uint8Array([1, 2, 3, 4]).buffer.slice(-1)).join());

// properties and tags
console.log(Int32Array.BYTES_PER_ELEMENT, Float64Array.BYTES_PER_ELEMENT, Uint8Array.BYTES_PER_ELEMENT, i32.BYTES_PER_ELEMENT);
console.log(Object.prototype.toString.call(i32), Object.prototype.toString.call(buf), Object.prototype.toString.call(shared));
console.log(String(bytes), `${new Int8Array([1, -1])}`, "" + new Float32Array([0.5]));
console.log(typeof i32, Array.isArray(i32), ArrayBuffer.isView(i32), ArrayBuffer.isView(buf), ArrayBuffer.isView([1]));
console.log(i32 instanceof Int32Array, (bytes as unknown) instanceof Int32Array, buf instanceof ArrayBuffer, shared instanceof SharedArrayBuffer);
console.log(JSON.stringify(new Uint8Array([1, 2])), JSON.stringify({ a: new Int8Array([1, -1]) }));
console.log(new Int32Array([1, 2, 3]), new Float64Array([1.5, -0, NaN]), new Uint8Array(0));
console.log(new ArrayBuffer(3), new SharedArrayBuffer(2));
console.log((i32 as any)[Symbol.toStringTag], typeof Uint8Array, Uint8Array.name, Uint8Array.length);
console.log(i32.constructor === Int32Array, Object.getPrototypeOf(i32) === Int32Array.prototype);
console.log(Object.getPrototypeOf(Int32Array.prototype) === Object.getPrototypeOf(Uint8Array.prototype));

// static constructors
console.log(Int32Array.from([1, 2, 3], (x) => x * 2).join(), Uint16Array.of(1, 2, 65537).join());
console.log(Uint8Array.from("123").join(), Float64Array.from(new Set([0.5])).join(), Int8Array.of().length);
console.log(Uint8Array.from([1, 2], function (this: { k: number }, x) { return x + this.k; }, { k: 10 }).join());

// errors
report("negative length", () => new Int32Array(-1));
report("fractional length", () => new Int32Array(-1.5));
report("offset not aligned", () => new Int32Array(new ArrayBuffer(8), 3));
report("offset past end", () => new Int8Array(new ArrayBuffer(4), 5));
report("negative offset", () => new Int32Array(new ArrayBuffer(8), -4));
report("buffer not aligned", () => new Int32Array(new ArrayBuffer(7)));
report("view past end", () => new Int32Array(new ArrayBuffer(8), 4, 2));
report("buffer length", () => new ArrayBuffer(-1));
report("call", () => (Int32Array as any)(3));
