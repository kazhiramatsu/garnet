// garnet:ndarray — n-dimensional arrays over typed storage (docs/ndarray_design.md).
//
// An NDArray is a contiguous row-major buffer (a typed array chosen by its dtype) with a
// shape. float64 is the default dtype and the fast path: its kernels are counted loops over
// Float64Array locals, which garnet compiles to direct element access; float32, the integer
// dtypes and the encoded 16-bit floats (float16 and bfloat16, stored as bits in a
// Uint16Array) go through the generic kernels, which read and write through the dtype.
// Arithmetic is done in double and stored through the dtype (an integer dtype wraps, a
// narrower float rounds), the same results as the native operation for + - * / and sqrt.
// Shapes must agree except for a scalar operand (a number); a mismatch throws a
// DimensionError, never a silent broadcast. Views: row(i) and reshape share the buffer;
// everything else copies. Random is a seeded xoshiro128** generator with numpy's Generator
// API, exact in both engines (int32 arithmetic only), so a program's numbers are the same
// under garnet and under Node.
//
// The design keeps the original DeepLearningJS idea of one initializer fed by a producer
// (`generate(shape, i => ...)`, `fromFunction(shape, (i, j) => ...)`, `from(shape,
// iterable)`); ES generators appear where laziness is natural (`rows()`, `entries()`,
// `Random.stream()`), never per element in a kernel.
//
// Derived from DeepLearningJS by Yusuke Sugomori (MIT License, Copyright (c) 2016):
// the shape vocabulary, the operator set and the activation functions; rewritten for
// typed storage, dtypes and TypeScript.

// A note on bounds: the kernels read a shape element into an integer local (`a.shape[0] | 0`)
// for their loops, separately from the value that goes into the result's shape literal. A
// local that also flows into an array literal stays boxed in garnet's generated code (an
// element read of a plain array may be undefined), and a boxed bound keeps a loop off the
// vectorized prefix loop (docs/typed_array_loops_design.md).

export type Shape = readonly number[];
export type Shape1 = readonly [number];
export type Shape2 = readonly [number, number];
export type Shape3 = readonly [number, number, number];
/** The rank below R (a row of a matrix is a vector). */
export type Lower<R extends number> = R extends 1 ? 0 : R extends 2 ? 1 : R extends 3 ? 2 : number;
export type TypedArray =
  | Float64Array | Float32Array | Int32Array | Int16Array | Int8Array
  | Uint8Array | Uint16Array | Uint32Array;
export type DTypeName =
  | "float64" | "float32" | "float16" | "bfloat16"
  | "int32" | "int16" | "int8" | "uint32" | "uint16" | "uint8";
export type Kind = "float" | "int" | "uint";

/** A storage type: how numbers are kept in the buffer. */
export interface DType {
  readonly name: DTypeName;
  readonly kind: Kind;
  readonly bytes: number;
  /** true when the buffer holds an encoding (float16, bfloat16): read through decode, write through encode */
  readonly encoded: boolean;
  alloc(size: number): TypedArray;
  decode(bits: number): number;
  encode(x: number): number;
}

export class DimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DimensionError";
  }
  static mismatch(a: Shape, b: Shape): DimensionError {
    return new DimensionError(`shapes (${a.join(",")}) and (${b.join(",")}) do not match`);
  }
  static incompatible(a: Shape, b: Shape, what: string): DimensionError {
    return new DimensionError(`shapes (${a.join(",")}) and (${b.join(",")}) are not compatible for ${what}`);
  }
  static rank(expected: string, got: Shape): DimensionError {
    return new DimensionError(`expected ${expected}, got shape (${got.join(",")})`);
  }
}

// ---------------------------------------------------------------- dtypes
// the 16-bit encodings use one scratch buffer viewed as float32 and as its bits
const scratch = new ArrayBuffer(8);
const scratchF32 = new Float32Array(scratch);
const scratchU32 = new Uint32Array(scratch);
const scratchF64 = new Float64Array(scratch);

function bf16Encode(x: number): number {
  scratchF32[0] = x;                          // round to float32 first (ml_dtypes does)
  const b = scratchU32[0];
  if ((b & 0x7fffffff) > 0x7f800000) return 0x7fc0 | ((b >>> 16) & 0x8000);   // NaN stays NaN
  return ((b + 0x7fff + ((b >>> 16) & 1)) >>> 16) & 0xffff;                    // round to nearest even
}
function bf16Decode(bits: number): number {
  scratchU32[0] = (bits & 0xffff) << 16;
  return scratchF32[0];
}
function f16Encode(x: number): number {
  // IEEE binary16 from the double's bits, round to nearest even (no Math.f16round: ES2020 lib)
  if (x !== x) return 0x7e00;
  scratchF64[0] = x;
  const hi = scratchU32[1], lo = scratchU32[0];
  const sign = (hi >>> 16) & 0x8000;
  const e = (hi >>> 20) & 0x7ff;
  if (e === 0x7ff) return sign | 0x7c00;                 // infinity
  const unbiased = e - 1023;
  if (unbiased > 15) return sign | 0x7c00;               // overflow (after rounding 65520 and above)
  // the 53-bit significand with the hidden bit, as two numbers: top 21 bits and low 32 bits
  const mantHi = (hi & 0xfffff) | (e === 0 ? 0 : 0x100000);
  let shift: number;                                     // bits dropped from the 53-bit significand
  let he: number;
  if (e === 0) return sign;                              // a double subnormal is below half's smallest subnormal / 2
  if (unbiased < -14) { shift = 42 + (-14 - unbiased); he = 0; }   // subnormal half
  else { shift = 42; he = unbiased + 15; }
  if (shift > 52) return sign;
  // kept = significand >> shift; the dropped part decides the rounding
  const sig = mantHi * 4294967296 + lo;                  // exact: 53 bits fit a double
  const pow = Math.pow(2, shift);
  let kept = Math.floor(sig / pow);
  const rem = sig - kept * pow;
  const half = pow / 2;
  if (rem > half || (rem === half && (kept & 1) === 1)) kept += 1;
  if (he === 0) {                                        // subnormal: a carry into the exponent is fine
    return sign | kept;
  }
  if (kept >= 0x800) { kept -= 0x400; he += 1; }         // the hidden bit after rounding up
  if (he >= 31) return sign | 0x7c00;
  return sign | (he << 10) | (kept & 0x3ff);
}
function f16Decode(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const e = (bits >>> 10) & 0x1f;
  const m = bits & 0x3ff;
  if (e === 0) return sign * m * 5.960464477539063e-8;            // 2^-24
  if (e === 31) return m === 0 ? sign * Infinity : NaN;
  return sign * (1 + m / 1024) * Math.pow(2, e - 15);
}
function plain(name: DTypeName, kind: Kind, bytes: number, alloc: (n: number) => TypedArray): DType {
  return { name, kind, bytes, encoded: false, alloc, decode: (b: number) => b, encode: (x: number) => x };
}
export const float64: DType = plain("float64", "float", 8, (n) => new Float64Array(n));
export const float32: DType = plain("float32", "float", 4, (n) => new Float32Array(n));
export const int32: DType = plain("int32", "int", 4, (n) => new Int32Array(n));
export const int16: DType = plain("int16", "int", 2, (n) => new Int16Array(n));
export const int8: DType = plain("int8", "int", 1, (n) => new Int8Array(n));
export const uint32: DType = plain("uint32", "uint", 4, (n) => new Uint32Array(n));
export const uint16: DType = plain("uint16", "uint", 2, (n) => new Uint16Array(n));
export const uint8: DType = plain("uint8", "uint", 1, (n) => new Uint8Array(n));
export const float16: DType = { name: "float16", kind: "float", bytes: 2, encoded: true, alloc: (n) => new Uint16Array(n), decode: f16Decode, encode: f16Encode };
export const bfloat16: DType = { name: "bfloat16", kind: "float", bytes: 2, encoded: true, alloc: (n) => new Uint16Array(n), decode: bf16Decode, encode: bf16Encode };
export const dtypes: readonly DType[] = [float64, float32, float16, bfloat16, int32, int16, int8, uint32, uint16, uint8];

export function dtype(name: DTypeName | DType): DType {
  if (typeof name !== "string") return name;
  for (const d of dtypes) if (d.name === name) return d;
  throw new TypeError(`unknown dtype ${name}`);
}

/** The result dtype of a binary operation (numpy's rules, without 64-bit integers). */
export function promote(a: DType, b: DType): DType {
  if (a === b) return a;
  if (a.kind === "float" || b.kind === "float") {
    if (a.kind !== "float") return b;
    if (b.kind !== "float") return a;
    if (a.bytes !== b.bytes) return a.bytes > b.bytes ? a : b;
    return float32;                           // float16 with bfloat16
  }
  if (a.kind === b.kind) return a.bytes >= b.bytes ? a : b;
  // signed with unsigned: the next wider signed type, float64 past int32
  const bytes = Math.max(a.bytes, b.bytes) * (a.bytes === b.bytes ? 2 : 1);
  const wider = a.bytes === b.bytes ? bytes : (a.kind === "int" ? (a.bytes > b.bytes ? a.bytes : b.bytes * 2) : (b.bytes > a.bytes ? b.bytes : a.bytes * 2));
  if (wider <= 2) return int16;
  if (wider <= 4) return int32;
  return float64;
}
/** The dtype of `array (op) scalar`: a number is weak, it keeps the array's dtype unless it is a fraction on an integer array. */
function promoteScalar(a: DType, s: number): DType {
  if (a.kind === "float") return a;
  return Number.isInteger(s) ? a : float64;
}

// ---------------------------------------------------------------- the array
function sizeOf(shape: Shape): number {
  let n = 1;
  for (let i = 0; i < shape.length; i++) {
    const d = shape[i];
    if (!Number.isInteger(d) || d < 0) throw new DimensionError(`invalid shape (${shape.join(",")})`);
    n *= d;
  }
  return n;
}
function stridesOf(shape: Shape): number[] {
  const s: number[] = new Array(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) { s[i] = acc; acc *= shape[i]; }
  return s;
}
function sameShape(a: Shape, b: Shape): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An n-dimensional array; `R` is the rank as a type only (Vector = NDArray<1>, Matrix = NDArray<2>). */
export class NDArray<R extends number = number> {
  readonly data: TypedArray;
  readonly dtype: DType;
  readonly shape: Shape;
  readonly strides: readonly number[];
  readonly size: number;
  readonly ndim: R;

  constructor(shape: Shape, dt: DType = float64, data?: TypedArray) {
    const size = sizeOf(shape);
    if (data !== undefined && data.length !== size) throw new DimensionError(`a buffer of ${data.length} elements cannot have shape (${shape.join(",")})`);
    this.shape = shape.slice();
    this.strides = stridesOf(shape);
    this.size = size;
    this.dtype = dt;
    this.data = data === undefined ? dt.alloc(size) : data;
    this.ndim = shape.length as R;
  }

  /** The element at a flat (row-major) index. */
  item(i: number): number {
    const d = this.dtype;
    return d.encoded ? d.decode(this.data[i]) : this.data[i];
  }
  setItem(i: number, v: number): void {
    const d = this.dtype;
    this.data[i] = d.encoded ? d.encode(v) : v;
  }
  /** The element at a multi-index (up to three axes without allocation). */
  at(i: number, j?: number, k?: number): number {
    return this.item(this.offset(i, j, k));
  }
  put(v: number, i: number, j?: number, k?: number): void {
    this.setItem(this.offset(i, j, k), v);
  }
  private offset(i: number, j?: number, k?: number): number {
    const s = this.strides, sh = this.shape;
    if (i < 0 || i >= sh[0] || !Number.isInteger(i)) throw new RangeError(`index ${i} out of bounds for axis 0 of size ${sh[0]}`);
    let o = i * s[0];
    if (j !== undefined) {
      if (sh.length < 2 || j < 0 || j >= sh[1] || !Number.isInteger(j)) throw new RangeError(`index ${j} out of bounds for axis 1`);
      o += j * s[1];
      if (k !== undefined) {
        if (sh.length < 3 || k < 0 || k >= sh[2] || !Number.isInteger(k)) throw new RangeError(`index ${k} out of bounds for axis 2`);
        o += k * s[2];
      }
    }
    return o;
  }
  /** The i-th sub-array along the first axis, a view sharing the buffer. */
  row(i: number): NDArray<Lower<R>> {
    if (this.shape.length === 0) throw DimensionError.rank("a rank of at least 1", this.shape);
    const n = this.shape[0];
    if (i < 0 || i >= n || !Number.isInteger(i)) throw new RangeError(`row ${i} out of bounds for axis 0 of size ${n}`);
    const stride = this.strides[0];
    const view = this.data.subarray(i * stride, (i + 1) * stride);
    return new NDArray<Lower<R>>(this.shape.slice(1), this.dtype, view);
  }
  /** The same buffer with another shape of the same size. */
  reshape(shape: Shape1): Vector;
  reshape(shape: Shape2): Matrix;
  reshape(shape: Shape3): Tensor3;
  reshape(shape: Shape): NDArray;
  reshape(shape: Shape): NDArray {
    if (sizeOf(shape) !== this.size) throw new DimensionError(`cannot reshape (${this.shape.join(",")}) into (${shape.join(",")})`);
    return new NDArray(shape, this.dtype, this.data);
  }
  copy(): NDArray<R> {
    return new NDArray<R>(this.shape, this.dtype, this.data.slice() as TypedArray);
  }
  /** The values converted to another dtype (a narrower float rounds, an integer dtype wraps). */
  astype(dt: DTypeName | DType): NDArray<R> {
    const to = dtype(dt);
    if (to === this.dtype) return this.copy();
    const out = new NDArray<R>(this.shape, to);
    const n = this.size;
    for (let i = 0; i < n; i++) out.setItem(i, this.item(i));
    return out;
  }
  /** The values of `src` copied in (the shapes must match); writes through a row view. */
  assign(src: NDArray): this {
    if (!sameShape(this.shape, src.shape)) throw DimensionError.mismatch(this.shape, src.shape);
    if (src.dtype === this.dtype) this.data.set(src.data);
    else for (let i = 0; i < this.size; i++) this.setItem(i, src.item(i));
    return this;
  }
  fill(v: number): this {
    const n = this.size;
    if (this.dtype.encoded) { const e = this.dtype.encode(v); for (let i = 0; i < n; i++) this.data[i] = e; }
    else this.data.fill(v);
    return this;
  }
  /** Nested arrays of numbers (a number for rank 0). */
  toArray(): unknown {
    const build = (axis: number, base: number): unknown => {
      if (axis === this.shape.length) return this.item(base);
      const n = this.shape[axis], stride = this.strides[axis];
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(build(axis + 1, base + i * stride));
      return out;
    };
    return build(0, 0);
  }
  toString(): string {
    return JSON.stringify(this.toArray());
  }
  /** The sub-arrays along the first axis, lazily. */
  *rows(): Generator<NDArray<Lower<R>>, void, undefined> {
    const n = this.shape.length === 0 ? 0 : this.shape[0];
    for (let i = 0; i < n; i++) yield this.row(i);
  }
  /** Every element with its multi-index, lazily, in row-major order. */
  *entries(): Generator<[number[], number], void, undefined> {
    const idx: number[] = new Array(this.shape.length).fill(0);
    for (let flat = 0; flat < this.size; flat++) {
      yield [idx.slice(), this.item(flat)];
      for (let a = idx.length - 1; a >= 0; a--) {
        if (++idx[a] < this.shape[a]) break;
        idx[a] = 0;
      }
    }
  }
  /** The values in row-major order, lazily. */
  *values(): Generator<number, void, undefined> {
    for (let i = 0; i < this.size; i++) yield this.item(i);
  }
}
export type Scalar = NDArray<0>;
export type Vector = NDArray<1>;
export type Matrix = NDArray<2>;
export type Tensor3 = NDArray<3>;

// ---------------------------------------------------------------- creation
export function empty(shape: Shape1, dt?: DTypeName | DType): Vector;
export function empty(shape: Shape2, dt?: DTypeName | DType): Matrix;
export function empty(shape: Shape3, dt?: DTypeName | DType): Tensor3;
export function empty(shape: Shape, dt?: DTypeName | DType): NDArray;
export function empty(shape: Shape, dt: DTypeName | DType = float64): NDArray {
  return new NDArray(shape, dtype(dt));
}
export function zeros(shape: Shape1, dt?: DTypeName | DType): Vector;
export function zeros(shape: Shape2, dt?: DTypeName | DType): Matrix;
export function zeros(shape: Shape3, dt?: DTypeName | DType): Tensor3;
export function zeros(shape: Shape, dt?: DTypeName | DType): NDArray;
export function zeros(shape: Shape, dt: DTypeName | DType = float64): NDArray {
  return new NDArray(shape, dtype(dt));
}
export function ones(shape: Shape1, dt?: DTypeName | DType): Vector;
export function ones(shape: Shape2, dt?: DTypeName | DType): Matrix;
export function ones(shape: Shape3, dt?: DTypeName | DType): Tensor3;
export function ones(shape: Shape, dt?: DTypeName | DType): NDArray;
export function ones(shape: Shape, dt: DTypeName | DType = float64): NDArray {
  return new NDArray(shape, dtype(dt)).fill(1);
}
export function full(shape: Shape1, value: number, dt?: DTypeName | DType): Vector;
export function full(shape: Shape2, value: number, dt?: DTypeName | DType): Matrix;
export function full(shape: Shape3, value: number, dt?: DTypeName | DType): Tensor3;
export function full(shape: Shape, value: number, dt?: DTypeName | DType): NDArray;
export function full(shape: Shape, value: number, dt: DTypeName | DType = float64): NDArray {
  return new NDArray(shape, dtype(dt)).fill(value);
}
/** One producer call per element, in row-major order, with the flat index. */
export function generate(shape: Shape1, produce: (flat: number) => number, dt?: DTypeName | DType): Vector;
export function generate(shape: Shape2, produce: (flat: number) => number, dt?: DTypeName | DType): Matrix;
export function generate(shape: Shape3, produce: (flat: number) => number, dt?: DTypeName | DType): Tensor3;
export function generate(shape: Shape, produce: (flat: number) => number, dt?: DTypeName | DType): NDArray;
export function generate(shape: Shape, produce: (flat: number) => number, dt: DTypeName | DType = float64): NDArray {
  const out = new NDArray(shape, dtype(dt));
  const n = out.size;
  if (out.dtype === float64) { const d = out.data as Float64Array; for (let i = 0; i < n; i++) d[i] = produce(i); }
  else for (let i = 0; i < n; i++) out.setItem(i, produce(i));
  return out;
}
/** One producer call per element with its indices (up to three axes). */
export function fromFunction(shape: Shape1, f: (i: number, j: number, k: number) => number, dt?: DTypeName | DType): Vector;
export function fromFunction(shape: Shape2, f: (i: number, j: number, k: number) => number, dt?: DTypeName | DType): Matrix;
export function fromFunction(shape: Shape3, f: (i: number, j: number, k: number) => number, dt?: DTypeName | DType): Tensor3;
export function fromFunction(shape: Shape, f: (i: number, j: number, k: number) => number, dt?: DTypeName | DType): NDArray;
export function fromFunction(shape: Shape, f: (i: number, j: number, k: number) => number, dt: DTypeName | DType = float64): NDArray {
  if (shape.length > 3) throw DimensionError.rank("a rank of at most 3 for fromFunction", shape);
  const out = new NDArray(shape, dtype(dt));
  const n0 = shape.length > 0 ? shape[0] : 1, n1 = shape.length > 1 ? shape[1] : 1, n2 = shape.length > 2 ? shape[2] : 1;
  let flat = 0;
  for (let i = 0; i < n0; i++) for (let j = 0; j < n1; j++) for (let k = 0; k < n2; k++) out.setItem(flat++, f(i, j, k));
  return out;
}
/** The first `size` numbers of an iterable (an array, a typed array, a generator) in row-major order. */
export function from(shape: Shape1, source: Iterable<number>, dt?: DTypeName | DType): Vector;
export function from(shape: Shape2, source: Iterable<number>, dt?: DTypeName | DType): Matrix;
export function from(shape: Shape3, source: Iterable<number>, dt?: DTypeName | DType): Tensor3;
export function from(shape: Shape, source: Iterable<number>, dt?: DTypeName | DType): NDArray;
export function from(shape: Shape, source: Iterable<number>, dt: DTypeName | DType = float64): NDArray {
  const out = new NDArray(shape, dtype(dt));
  let i = 0;
  for (const v of source) {
    if (i === out.size) break;
    out.setItem(i++, v);
  }
  if (i !== out.size) throw new DimensionError(`the source has ${i} elements, shape (${shape.join(",")}) needs ${out.size}`);
  return out;
}
/** Nested arrays of numbers, the shape inferred; a ragged nesting is a DimensionError. */
export function tensor(nested: number, dt?: DTypeName | DType): Scalar;
export function tensor(nested: readonly number[], dt?: DTypeName | DType): Vector;
export function tensor(nested: readonly (readonly number[])[], dt?: DTypeName | DType): Matrix;
export function tensor(nested: readonly (readonly (readonly number[])[])[], dt?: DTypeName | DType): Tensor3;
export function tensor(nested: unknown, dt?: DTypeName | DType): NDArray;
export function tensor(nested: unknown, dt: DTypeName | DType = float64): NDArray {
  const shape: number[] = [];
  let probe: unknown = nested;
  while (Array.isArray(probe)) { shape.push(probe.length); probe = probe.length > 0 ? probe[0] : undefined; }
  const out = new NDArray(shape, dtype(dt));
  let flat = 0;
  const walk = (v: unknown, axis: number): void => {
    if (axis === shape.length) {
      if (typeof v !== "number") throw new TypeError(`element at ${flat} is not a number`);
      out.setItem(flat++, v);
      return;
    }
    if (!Array.isArray(v) || v.length !== shape[axis]) throw new DimensionError(`ragged nesting at axis ${axis}`);
    for (let i = 0; i < v.length; i++) walk(v[i], axis + 1);
  };
  walk(nested, 0);
  return out;
}
export function arange(start: number, stop?: number, step: number = 1, dt: DTypeName | DType = float64): Vector {
  if (stop === undefined) { stop = start; start = 0; }
  if (step === 0) throw new RangeError("arange step must not be zero");
  const n = Math.max(0, Math.ceil((stop - start) / step));
  return generate([n] as const, (i) => start + i * step, dt);
}
export function linspace(start: number, stop: number, num: number, dt: DTypeName | DType = float64): Vector {
  if (num < 2) return full([num] as const, start, dt);
  const step = (stop - start) / (num - 1);
  return generate([num] as const, (i) => (i === num - 1 ? stop : start + i * step), dt);
}
export function eye(n: number, dt: DTypeName | DType = float64): Matrix {
  const out = new NDArray<2>([n, n], dtype(dt));
  for (let i = 0; i < n; i++) out.setItem(i * n + i, 1);
  return out;
}

// ---------------------------------------------------------------- random
/** numpy's Generator over xoshiro128**: seeded, and the same stream under garnet and Node. */
export class Random {
  private s0: number; private s1: number; private s2: number; private s3: number;
  constructor(seed: number) {
    // splitmix32 expands the seed into the four state words
    let x = seed | 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) | 0;
    };
    this.s0 = next(); this.s1 = next(); this.s2 = next(); this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }
  /** The next 32 bits as an unsigned integer. */
  nextU32(): number {
    const s0 = this.s0, s1 = this.s1, s2 = this.s2, s3 = this.s3;
    const r5 = Math.imul(s1, 5);
    const result = Math.imul((r5 << 7) | (r5 >>> 25), 9);
    const t = s1 << 9;
    let n2 = s2 ^ s0, n3 = s3 ^ s1;
    this.s1 = s1 ^ n2;
    this.s0 = s0 ^ n3;
    n2 ^= t;
    this.s3 = (n3 << 11) | (n3 >>> 21);
    this.s2 = n2;
    return result >>> 0;
  }
  /** A double in [0, 1) with 53 random bits. */
  next(): number {
    const hi = this.nextU32() >>> 5, lo = this.nextU32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }
  uniform(low: number, high: number): number;
  uniform(low: number, high: number, shape: Shape1, dt?: DTypeName | DType): Vector;
  uniform(low: number, high: number, shape: Shape2, dt?: DTypeName | DType): Matrix;
  uniform(low: number, high: number, shape: Shape3, dt?: DTypeName | DType): Tensor3;
  uniform(low: number, high: number, shape: Shape, dt?: DTypeName | DType): NDArray;
  uniform(low: number, high: number, shape?: Shape, dt: DTypeName | DType = float64): number | NDArray {
    const span = high - low;
    if (shape === undefined) return low + this.next() * span;
    return generate(shape, () => low + this.next() * span, dt);
  }
  /** Box–Muller; both normals of a pair are used. */
  normal(mean?: number, std?: number): number;
  normal(mean: number, std: number, shape: Shape1, dt?: DTypeName | DType): Vector;
  normal(mean: number, std: number, shape: Shape2, dt?: DTypeName | DType): Matrix;
  normal(mean: number, std: number, shape: Shape3, dt?: DTypeName | DType): Tensor3;
  normal(mean: number, std: number, shape: Shape, dt?: DTypeName | DType): NDArray;
  normal(mean: number = 0, std: number = 1, shape?: Shape, dt: DTypeName | DType = float64): number | NDArray {
    if (shape === undefined) return mean + std * this.gauss();
    return generate(shape, () => mean + std * this.gauss(), dt);
  }
  private spare: number | null = null;
  private gauss(): number {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    const u = 1 - this.next();                 // (0, 1]: log never sees 0
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    this.spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  }
  /** Integers in [low, high). */
  integers(low: number, high: number): number;
  integers(low: number, high: number, shape: Shape1, dt?: DTypeName | DType): Vector;
  integers(low: number, high: number, shape: Shape2, dt?: DTypeName | DType): Matrix;
  integers(low: number, high: number, shape: Shape, dt?: DTypeName | DType): NDArray;
  integers(low: number, high: number, shape?: Shape, dt: DTypeName | DType = int32): number | NDArray {
    const span = high - low;
    if (span <= 0) throw new RangeError("integers needs low < high");
    if (shape === undefined) return low + Math.floor(this.next() * span);
    return generate(shape, () => low + Math.floor(this.next() * span), dt);
  }
  /** An endless stream of uniform numbers in [low, high), for `from(shape, rng.stream())`. */
  *stream(low: number = 0, high: number = 1): Generator<number, void, undefined> {
    const span = high - low;
    for (;;) yield low + this.next() * span;
  }
  /** Fisher–Yates over the first axis, in place. */
  shuffle(a: NDArray): void {
    const n = a.shape.length === 0 ? 0 : a.shape[0];
    const stride = a.strides[0];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      if (i === j) continue;
      for (let k = 0; k < stride; k++) {
        const t = a.data[i * stride + k];
        a.data[i * stride + k] = a.data[j * stride + k];
        a.data[j * stride + k] = t;
      }
    }
  }
}

// ---------------------------------------------------------------- elementwise
type Bin = (x: number, y: number) => number;
type Un = (x: number) => number;

function binary(a: NDArray | number, b: NDArray | number, what: string, op: Bin,
                f64: (x: Float64Array, y: Float64Array, out: Float64Array, n: number) => void,
                f64s: (x: Float64Array, s: number, out: Float64Array, n: number, scalarLeft: boolean) => void): NDArray | number {
  if (typeof a === "number") {
    if (typeof b === "number") return op(a, b);
    const out = new NDArray(b.shape, promoteScalar(b.dtype, a));
    if (out.dtype === float64 && b.dtype === float64) f64s(b.data as Float64Array, a, out.data as Float64Array, out.size, true);
    else for (let i = 0; i < out.size; i++) out.setItem(i, op(a, b.item(i)));
    return out;
  }
  if (typeof b === "number") {
    const out = new NDArray(a.shape, promoteScalar(a.dtype, b));
    if (out.dtype === float64 && a.dtype === float64) f64s(a.data as Float64Array, b, out.data as Float64Array, out.size, false);
    else for (let i = 0; i < out.size; i++) out.setItem(i, op(a.item(i), b));
    return out;
  }
  if (!sameShape(a.shape, b.shape)) throw DimensionError.mismatch(a.shape, b.shape);
  const out = new NDArray(a.shape, promote(a.dtype, b.dtype));
  if (out.dtype === float64 && a.dtype === float64 && b.dtype === float64) f64(a.data as Float64Array, b.data as Float64Array, out.data as Float64Array, out.size);
  else for (let i = 0; i < out.size; i++) out.setItem(i, op(a.item(i), b.item(i)));
  return out;
}

export function add<R extends number>(a: NDArray<R>, b: NDArray<R> | number): NDArray<R>;
export function add<R extends number>(a: number, b: NDArray<R>): NDArray<R>;
export function add(a: number, b: number): number;
export function add(a: NDArray | number, b: NDArray | number): NDArray | number {
  return binary(a, b, "add", (x, y) => x + y,
    (x, y, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] + y[i]; },
    (x, s, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] + s; });
}
export function sub<R extends number>(a: NDArray<R>, b: NDArray<R> | number): NDArray<R>;
export function sub<R extends number>(a: number, b: NDArray<R>): NDArray<R>;
export function sub(a: number, b: number): number;
export function sub(a: NDArray | number, b: NDArray | number): NDArray | number {
  return binary(a, b, "sub", (x, y) => x - y,
    (x, y, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] - y[i]; },
    (x, s, o, n, left) => { if (left) for (let i = 0; i < n; i++) o[i] = s - x[i]; else for (let i = 0; i < n; i++) o[i] = x[i] - s; });
}
export function mul<R extends number>(a: NDArray<R>, b: NDArray<R> | number): NDArray<R>;
export function mul<R extends number>(a: number, b: NDArray<R>): NDArray<R>;
export function mul(a: number, b: number): number;
export function mul(a: NDArray | number, b: NDArray | number): NDArray | number {
  return binary(a, b, "mul", (x, y) => x * y,
    (x, y, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] * y[i]; },
    (x, s, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] * s; });
}
export function div<R extends number>(a: NDArray<R>, b: NDArray<R> | number): NDArray<R>;
export function div<R extends number>(a: number, b: NDArray<R>): NDArray<R>;
export function div(a: number, b: number): number;
export function div(a: NDArray | number, b: NDArray | number): NDArray | number {
  // an integer dtype divides into float64, as numpy's true division does
  const lift = (v: NDArray | number): NDArray | number => (typeof v !== "number" && v.dtype.kind !== "float") ? v.astype(float64) : v;
  return binary(lift(a), lift(b), "div", (x, y) => x / y,
    (x, y, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] / y[i]; },
    (x, s, o, n, left) => { if (left) for (let i = 0; i < n; i++) o[i] = s / x[i]; else for (let i = 0; i < n; i++) o[i] = x[i] / s; });
}
/** One function over every element; the result has the same dtype (`dt` to choose another). */
export function map<R extends number>(a: NDArray<R>, f: Un, dt?: DTypeName | DType): NDArray<R> {
  const out = new NDArray<R>(a.shape, dt === undefined ? a.dtype : dtype(dt));
  const n = a.size;
  if (out.dtype === float64 && a.dtype === float64) { const x = a.data as Float64Array, o = out.data as Float64Array; for (let i = 0; i < n; i++) o[i] = f(x[i]); }
  else for (let i = 0; i < n; i++) out.setItem(i, f(a.item(i)));
  return out;
}
export function neg<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => -x); }
export function abs<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => Math.abs(x)); }
export function sqrt<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => Math.sqrt(x), a.dtype.kind === "float" ? a.dtype : float64); }
export function exp<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => Math.exp(x), a.dtype.kind === "float" ? a.dtype : float64); }
export function log<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => Math.log(x), a.dtype.kind === "float" ? a.dtype : float64); }
export function tanh<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => Math.tanh(x), a.dtype.kind === "float" ? a.dtype : float64); }
export function sigmoid<R extends number>(a: NDArray<R>): NDArray<R> { return map(a, (x) => 1 / (1 + Math.exp(-x)), a.dtype.kind === "float" ? a.dtype : float64); }
export function clip<R extends number>(a: NDArray<R>, low: number, high: number): NDArray<R> { return map(a, (x) => (x < low ? low : x > high ? high : x)); }
export function maximum<R extends number>(a: NDArray<R>, b: NDArray<R> | number): NDArray<R> {
  return binary(a, b, "maximum", (x, y) => (x >= y ? x : y),
    (x, y, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] >= y[i] ? x[i] : y[i]; },
    (x, s, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] >= s ? x[i] : s; }) as NDArray<R>;
}
export function minimum<R extends number>(a: NDArray<R>, b: NDArray<R> | number): NDArray<R> {
  return binary(a, b, "minimum", (x, y) => (x <= y ? x : y),
    (x, y, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] <= y[i] ? x[i] : y[i]; },
    (x, s, o, n) => { for (let i = 0; i < n; i++) o[i] = x[i] <= s ? x[i] : s; }) as NDArray<R>;
}

// ---------------------------------------------------------------- reductions
export function sum(a: NDArray): number {
  const n = a.size;
  let s = 0;
  if (a.dtype === float64) { const x = a.data as Float64Array; for (let i = 0; i < n; i++) s += x[i]; }
  else for (let i = 0; i < n; i++) s += a.item(i);
  return s;
}
export function mean(a: NDArray): number {
  return a.size === 0 ? NaN : sum(a) / a.size;
}
export function max(a: NDArray): number {
  if (a.size === 0) throw new DimensionError("max of an empty array");
  let m = a.item(0);
  for (let i = 1; i < a.size; i++) { const v = a.item(i); if (v > m || v !== v) m = v; }
  return m;
}
export function min(a: NDArray): number {
  if (a.size === 0) throw new DimensionError("min of an empty array");
  let m = a.item(0);
  for (let i = 1; i < a.size; i++) { const v = a.item(i); if (v < m || v !== v) m = v; }
  return m;
}
/** The flat index of the first maximum (NaN wins, as in numpy). */
export function argmax(a: NDArray): number {
  if (a.size === 0) throw new DimensionError("argmax of an empty array");
  let m = a.item(0), at = 0;
  if (m !== m) return 0;
  for (let i = 1; i < a.size; i++) { const v = a.item(i); if (v !== v) return i; if (v > m) { m = v; at = i; } }
  return at;
}
export function argmin(a: NDArray): number {
  if (a.size === 0) throw new DimensionError("argmin of an empty array");
  let m = a.item(0), at = 0;
  if (m !== m) return 0;
  for (let i = 1; i < a.size; i++) { const v = a.item(i); if (v !== v) return i; if (v < m) { m = v; at = i; } }
  return at;
}

// ---------------------------------------------------------------- linear algebra
export function dot(a: Vector, b: Vector): number;
export function dot(a: Matrix, b: Vector): Vector;
export function dot(a: Vector, b: Matrix): Vector;
export function dot(a: Matrix, b: Matrix): Matrix;
export function dot(a: NDArray, b: NDArray): NDArray | number;
export function dot(a: NDArray, b: NDArray): NDArray | number {
  const ra = a.shape.length, rb = b.shape.length;
  const dt = promote(a.dtype, b.dtype);
  const fast = a.dtype === float64 && b.dtype === float64;
  if (ra === 1 && rb === 1) {
    if (a.shape[0] !== b.shape[0]) throw DimensionError.incompatible(a.shape, b.shape, "dot");
    const n = a.shape[0] | 0;
    let s = 0;
    if (fast) { const x = a.data as Float64Array, y = b.data as Float64Array; for (let i = 0; i < n; i++) s += x[i] * y[i]; }
    else for (let i = 0; i < n; i++) s += a.item(i) * b.item(i);
    return s;
  }
  if (ra === 2 && rb === 1) {
    if (a.shape[1] !== b.shape[0]) throw DimensionError.incompatible(a.shape, b.shape, "dot");
    const out = new NDArray<1>([a.shape[0]], dt);
    const m = a.shape[0] | 0, k = a.shape[1] | 0;   // integer locals for the loops (the note on bounds above)
    if (fast) {
      const x = a.data as Float64Array, y = b.data as Float64Array, o = out.data as Float64Array;
      for (let i = 0; i < m; i++) { let s = 0; const base = i * k; for (let j = 0; j < k; j++) s += x[base + j] * y[j]; o[i] = s; }
    } else for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < k; j++) s += a.item(i * k + j) * b.item(j); out.setItem(i, s); }
    return out;
  }
  if (ra === 1 && rb === 2) {
    if (a.shape[0] !== b.shape[0]) throw DimensionError.incompatible(a.shape, b.shape, "dot");
    const out = new NDArray<1>([b.shape[1]], dt);
    const k = b.shape[0] | 0, n = b.shape[1] | 0;
    // row by row of b, the inner loop contiguous (a counted loop the compiler vectorizes)
    if (fast) {
      const x = a.data as Float64Array, y = b.data as Float64Array, o = out.data as Float64Array;
      for (let i = 0; i < k; i++) { const xi = x[i], rb = i * n; for (let j = 0; j < n; j++) o[j] += xi * y[rb + j]; }
    } else for (let i = 0; i < k; i++) { const xi = a.item(i); for (let j = 0; j < n; j++) out.setItem(j, out.item(j) + xi * b.item(i * n + j)); }
    return out;
  }
  if (ra === 2 && rb === 2) {
    if (a.shape[1] !== b.shape[0]) throw DimensionError.incompatible(a.shape, b.shape, "dot");
    const out = new NDArray<2>([a.shape[0], b.shape[1]], dt);
    const m = a.shape[0] | 0, k = a.shape[1] | 0, n = b.shape[1] | 0;
    // i-k-j: the inner loop walks a row of b and a row of the result contiguously
    if (fast) {
      const x = a.data as Float64Array, y = b.data as Float64Array, o = out.data as Float64Array;
      for (let i = 0; i < m; i++) {
        const ro = i * n;
        for (let p = 0; p < k; p++) { const aip = x[i * k + p], rb = p * n; for (let j = 0; j < n; j++) o[ro + j] += aip * y[rb + j]; }
      }
    } else for (let i = 0; i < m; i++) for (let p = 0; p < k; p++) { const aip = a.item(i * k + p); for (let j = 0; j < n; j++) out.setItem(i * n + j, out.item(i * n + j) + aip * b.item(p * n + j)); }
    return out;
  }
  throw DimensionError.incompatible(a.shape, b.shape, "dot (ranks 1 and 2 only)");
}
export function outer(u: NDArray, v: NDArray): Matrix {
  if (u.shape.length !== 1 || v.shape.length !== 1) throw DimensionError.incompatible(u.shape, v.shape, "outer");
  const out = new NDArray<2>([u.shape[0], v.shape[0]], promote(u.dtype, v.dtype));
  const m = u.shape[0] | 0, n = v.shape[0] | 0;
  if (out.dtype === float64 && u.dtype === float64 && v.dtype === float64) {
    const x = u.data as Float64Array, y = v.data as Float64Array, o = out.data as Float64Array;
    for (let i = 0; i < m; i++) { const ui = x[i]; for (let j = 0; j < n; j++) o[i * n + j] = ui * y[j]; }
  } else for (let i = 0; i < m; i++) { const ui = u.item(i); for (let j = 0; j < n; j++) out.setItem(i * n + j, ui * v.item(j)); }
  return out;
}
/** The axes reversed (a copy); a vector is returned as is. */
export function transpose<R extends number>(a: NDArray<R>): NDArray<R>;
export function transpose(a: NDArray): NDArray {
  const r = a.shape.length;
  if (r < 2) return a.copy();
  if (r === 2) {
    const out = new NDArray([a.shape[1], a.shape[0]], a.dtype);
    const m = a.shape[0] | 0, n = a.shape[1] | 0;
    if (a.dtype === float64) { const x = a.data as Float64Array, o = out.data as Float64Array; for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) o[j * m + i] = x[i * n + j]; }
    else for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) out.data[j * m + i] = a.data[i * n + j];
    return out;
  }
  const shape = a.shape.slice().reverse();
  const out = new NDArray(shape, a.dtype);
  const idx: number[] = new Array(r).fill(0);
  for (let flat = 0; flat < a.size; flat++) {
    let o = 0;
    for (let ax = 0; ax < r; ax++) o += idx[ax] * out.strides[r - 1 - ax];
    out.data[o] = a.data[flat];
    for (let ax = r - 1; ax >= 0; ax--) { if (++idx[ax] < a.shape[ax]) break; idx[ax] = 0; }
  }
  return out;
}
export { transpose as T };

// ---------------------------------------------------------------- shape operations
export function flatten(a: NDArray): Vector {
  return new NDArray<1>([a.size], a.dtype, a.data.slice() as TypedArray);
}
/** Rows [r0, r1) and columns [c0, c1) of a matrix, a copy. */
export function slice(a: NDArray, rows: readonly [number, number], cols?: readonly [number, number]): Matrix {
  if (a.shape.length !== 2) throw DimensionError.rank("a matrix", a.shape);
  const [r0, r1] = rows;
  const [c0, c1] = cols === undefined ? [0, a.shape[1]] : cols;
  if (r0 < 0 || r1 > a.shape[0] || r0 > r1 || c0 < 0 || c1 > a.shape[1] || c0 > c1) throw new RangeError(`slice [${r0},${r1}) x [${c0},${c1}) outside (${a.shape.join(",")})`);
  const n = a.shape[1], w = c1 - c0;
  const out = new NDArray<2>([r1 - r0, w], a.dtype);
  for (let i = r0; i < r1; i++) for (let j = 0; j < w; j++) out.data[(i - r0) * w + j] = a.data[i * n + c0 + j];
  return out;
}
/** Arrays joined along an axis (0 or 1 for matrices, 0 for vectors). */
export function concat<R extends number>(parts: readonly NDArray<R>[], axis?: number): NDArray<R>;
export function concat(parts: readonly NDArray[], axis: number = 0): NDArray {
  if (parts.length === 0) throw new DimensionError("concat of nothing");
  const first = parts[0];
  const r = first.shape.length;
  let dt = first.dtype;
  for (const p of parts) dt = promote(dt, p.dtype);
  if (r === 1 || (r === 2 && axis === 0)) {
    let total = 0;
    for (const p of parts) {
      if (p.shape.length !== r || (r === 2 && p.shape[1] !== first.shape[1])) throw DimensionError.incompatible(first.shape, p.shape, "concat");
      total += p.shape[0];
    }
    const out = new NDArray(r === 1 ? [total] : [total, first.shape[1]], dt);
    let at = 0;
    for (const p of parts) {
      if (p.dtype === dt) { out.data.set(p.data, at); at += p.size; }
      else for (let i = 0; i < p.size; i++) out.setItem(at++, p.item(i));
    }
    return out;
  }
  if (r === 2 && axis === 1) {
    const m = first.shape[0];
    let width = 0;
    for (const p of parts) {
      if (p.shape.length !== 2 || p.shape[0] !== m) throw DimensionError.incompatible(first.shape, p.shape, "concat");
      width += p.shape[1];
    }
    const out = new NDArray<2>([m, width], dt);
    let col = 0;
    for (const p of parts) {
      const w = p.shape[1];
      for (let i = 0; i < m; i++) for (let j = 0; j < w; j++) out.setItem(i * width + col + j, p.item(i * w + j));
      col += w;
    }
    return out;
  }
  throw DimensionError.rank("vectors or matrices with axis 0 or 1", first.shape);
}
export function equals(a: NDArray, b: NDArray): boolean {
  if (!sameShape(a.shape, b.shape)) return false;
  for (let i = 0; i < a.size; i++) if (a.item(i) !== b.item(i)) return false;
  return true;
}
export function allclose(a: NDArray, b: NDArray, rtol: number = 1e-5, atol: number = 1e-8): boolean {
  if (!sameShape(a.shape, b.shape)) return false;
  for (let i = 0; i < a.size; i++) {
    const x = a.item(i), y = b.item(i);
    if (Math.abs(x - y) > atol + rtol * Math.abs(y)) return false;
  }
  return true;
}
