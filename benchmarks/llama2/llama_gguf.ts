// llama_gguf.ts: inference of a llama-architecture model from a llama.cpp GGUF file, in
// TypeScript (docs/llm_inference_design.md, milestone 2). Reads GGUF v2/v3 (the metadata, the
// tensor infos, the data section), the quantizations F32, F16 and Q8_0 (Q4_0 for the weights of
// the smaller files), the SentencePiece-style BPE of the vocabulary in the file, and runs the
// llama forward pass with grouped-query attention, RoPE, RMSNorm and SwiGLU, greedy sampling by
// default. The Q8_0 matrix-vector product quantizes the activation to int8 per block of 32 as
// llama.cpp does, so a block's dot product is an integer sum of 32 int8 products (`| 0`
// arithmetic, exact in int32, which the C compiler may vectorize), scaled by the two block
// scales. The u64 fields of the format are read as two u32 words into a double (no bigint).
//
// Usage: llama_gguf <model.gguf> [-n steps] [-p "prompt"] [-t temperature] [-s seed] [--raw]
//   The prompt is wrapped in TinyLlama-Chat's template unless --raw is given.
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- GGUF
const GGML_F32 = 0, GGML_F16 = 1, GGML_Q4_0 = 2, GGML_Q8_0 = 8;
interface TensorInfo { name: string; dims: number[]; type: number; offset: number }
interface Gguf { kv: Map<string, unknown>; tensors: Map<string, TensorInfo>; data: number; bytes: Uint8Array }

class Reader {
  pos = 0;
  private readonly scratch = new ArrayBuffer(8);
  private readonly su = new Uint8Array(this.scratch);
  private readonly sf = new Float32Array(this.scratch);
  private readonly sd = new Float64Array(this.scratch);
  private readonly decoder = new TextDecoder();
  constructor(readonly b: Uint8Array) {}
  u8(): number { return this.b[this.pos++]; }
  u16(): number { const v = this.b[this.pos] | (this.b[this.pos + 1] << 8); this.pos += 2; return v; }
  u32(): number { const b = this.b, p = this.pos; this.pos += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  i32(): number { return this.u32() | 0; }
  u64(): number { const lo = this.u32(); const hi = this.u32(); return lo + hi * 4294967296; }
  f32(): number { for (let i = 0; i < 4; i++) this.su[i] = this.b[this.pos + i]; this.pos += 4; return this.sf[0]; }
  f64(): number { for (let i = 0; i < 8; i++) this.su[i] = this.b[this.pos + i]; this.pos += 8; return this.sd[0]; }
  str(): string { const n = this.u64(); const s = this.decoder.decode(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
  value(type: number): unknown {
    switch (type) {
      case 0: return this.u8();
      case 1: return (this.u8() << 24) >> 24;
      case 2: return this.u16();
      case 3: return (this.u16() << 16) >> 16;
      case 4: return this.u32();
      case 5: return this.i32();
      case 6: return this.f32();
      case 7: return this.u8() !== 0;
      case 8: return this.str();
      case 9: {
        const t = this.u32(), n = this.u64();
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(this.value(t));
        return out;
      }
      case 10: return this.u64();
      case 11: { const lo = this.u32(); const hi = this.i32(); return lo + hi * 4294967296; }
      case 12: return this.f64();
      default: throw new Error(`gguf: unknown value type ${type}`);
    }
  }
}
function readGguf(path: string): Gguf {
  const file = readFileSync(path);
  // the file's buffer viewed in place; the tensor data is aligned in the file, so the view's
  // own offset must keep that alignment (a copy otherwise)
  let bytes: Uint8Array = file;
  if (file.byteOffset % 32 !== 0) { bytes = new Uint8Array(file.length); bytes.set(file); }
  const r = new Reader(bytes);
  const magic = r.u32();
  if (magic !== 0x46554747) throw new Error("not a GGUF file");
  const version = r.u32();
  if (version < 2 || version > 3) throw new Error(`gguf version ${version} not supported`);
  const nTensors = r.u64(), nKv = r.u64();
  const kv = new Map<string, unknown>();
  for (let i = 0; i < nKv; i++) {
    const key = r.str();
    const type = r.u32();
    kv.set(key, r.value(type));
  }
  const tensors = new Map<string, TensorInfo>();
  for (let i = 0; i < nTensors; i++) {
    const name = r.str();
    const nd = r.u32();
    const dims: number[] = [];
    for (let d = 0; d < nd; d++) dims.push(r.u64());
    const type = r.u32();
    const offset = r.u64();
    tensors.set(name, { name, dims, type, offset });
  }
  const alignment = (kv.get("general.alignment") as number | undefined) ?? 32;
  const data = Math.ceil(r.pos / alignment) * alignment;
  return { kv, tensors, data, bytes };
}

// ---------------------------------------------------------------- the tensors
/** half precision to double, exact */
function f16ToF64(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const e = (bits >>> 10) & 0x1f, m = bits & 0x3ff;
  if (e === 0) return sign * m * 5.960464477539063e-8;
  if (e === 31) return m === 0 ? sign * Infinity : NaN;
  return sign * (1 + m / 1024) * Math.pow(2, e - 15);
}
const F16 = new Float32Array(65536);
for (let i = 0; i < 65536; i++) F16[i] = f16ToF64(i);

/** A weight matrix: `rows` rows of `cols` values in one quantization; `bytes` and `quants` view the
 *  tensor's own bytes (a tensor is below 2^31 bytes, so every index into them is an int32, which keeps
 *  the kernels' loads on the inline path; the file offset itself may not be). */
class Weight {
  readonly bytes: Uint8Array;
  readonly quants: Int8Array;
  readonly f32: Float32Array;
  constructor(readonly name: string, readonly type: number, readonly rows: number, readonly cols: number, readonly byteOff: number, all: Uint8Array) {
    const rowBytes = type === GGML_F32 ? cols * 4 : type === GGML_F16 ? cols * 2 : type === GGML_Q8_0 ? (cols >> 5) * 34 : (cols >> 5) * 18;
    const n = rows * rowBytes;
    this.bytes = all.subarray(byteOff, byteOff + n);
    this.quants = new Int8Array(all.buffer, all.byteOffset + byteOff, n);
    this.f32 = type === GGML_F32 ? new Float32Array(all.buffer, all.byteOffset + byteOff, n >> 2) : new Float32Array(0);
  }
}
class Model {
  readonly g: Gguf;
  readonly u8: Uint8Array;        // the file's bytes
  readonly i8: Int8Array;         // the same bytes as int8 (the Q8_0 quants)
  readonly f32: Float32Array;     // the same bytes as float32 (F32 tensors; offsets are multiples of 4)
  readonly dataStart: number;
  constructor(g: Gguf) {
    this.g = g;
    this.u8 = g.bytes;
    this.i8 = new Int8Array(g.bytes.buffer, g.bytes.byteOffset, g.bytes.byteLength);
    const f32Len = (g.bytes.byteLength - ((g.bytes.byteOffset) % 4)) >> 2;
    this.f32 = new Float32Array(g.bytes.buffer, g.bytes.byteOffset, f32Len);
    this.dataStart = g.data;
  }
  weight(name: string): Weight {
    const t = this.g.tensors.get(name);
    if (t === undefined) throw new Error(`tensor ${name} missing`);
    const cols = t.dims[0], rows = t.dims.length > 1 ? t.dims[1] : 1;
    if (t.type !== GGML_F32 && t.type !== GGML_F16 && t.type !== GGML_Q8_0 && t.type !== GGML_Q4_0) throw new Error(`tensor ${name}: quantization type ${t.type} not supported`);
    if ((t.type === GGML_Q8_0 || t.type === GGML_Q4_0) && cols % 32 !== 0) throw new Error(`tensor ${name}: ${cols} columns is not a multiple of 32`);
    return new Weight(name, t.type, rows, cols, this.dataStart + t.offset, this.u8);
  }
  /** Row `r` of a weight as doubles into `out` (embeddings, norms). */
  row(w: Weight, r: number, out: Float32Array): void {
    const n = w.cols | 0;
    if (w.type === GGML_F32) {
      const f = w.f32, base = r * n;
      for (let i = 0; i < n; i++) out[i] = f[base + i];
    } else if (w.type === GGML_F16) {
      const u = w.bytes;
      let p = Math.imul(r, n * 2);
      for (let i = 0; i < n; i++) { out[i] = F16[u[p] | (u[p + 1] << 8)]; p += 2; }
    } else if (w.type === GGML_Q8_0) {
      const u = w.bytes, q = w.quants;
      let p = Math.imul(r, (n >> 5) * 34);
      for (let b = 0; b < n; b += 32) {
        const d = F16[u[p] | (u[p + 1] << 8)];
        for (let j = 0; j < 32; j++) out[b + j] = d * q[p + 2 + j];
        p += 34;
      }
    } else {
      const u = w.bytes;
      let p = Math.imul(r, (n >> 5) * 18);
      for (let b = 0; b < n; b += 32) {
        const d = F16[u[p] | (u[p + 1] << 8)];
        for (let j = 0; j < 16; j++) { const byte = u[p + 2 + j]; out[b + j] = d * ((byte & 15) - 8); out[b + j + 16] = d * ((byte >> 4) - 8); }
        p += 18;
      }
    }
  }
}

// ---------------------------------------------------------------- the kernels
/** x quantized to int8 per block of 32 with a float scale (llama.cpp's quantize_row_q8_0 rounding). */
function quantizeQ8(x: Float32Array, n: number, xq: Int8Array, xs: Float32Array): void {
  for (let b = 0; b < n; b += 32) {
    let amax = 0;
    for (let j = 0; j < 32; j++) { const a = Math.abs(x[b + j]); if (a > amax) amax = a; }
    const d = amax / 127;
    const id = d !== 0 ? 1 / d : 0;
    xs[b >> 5] = d;
    for (let j = 0; j < 32; j++) xq[b + j] = Math.round(x[b + j] * id);
  }
}
/** out = W x for a Q8_0 weight, the activation already quantized (xq, xs). */
function matvecQ8(m: Model, w: Weight, xq: Int8Array, xs: Float32Array, out: Float32Array): void {
  const u = w.bytes, q = w.quants;
  const n = w.cols | 0, rows = w.rows | 0, nb = n >> 5;
  const rowBytes = nb * 34;
  for (let r = 0; r < rows; r++) {
    let s = 0;
    let p = Math.imul(r, rowBytes);        // an int32 row offset (a tensor is below 2^31 bytes)
    for (let b = 0; b < nb; b++) {
      const qb = p + 2, xb = b << 5;
      let isum = 0;
      // the int8 values sign-extended by shifts (the numeric analysis bounds `>> 24` to the int8
      // range, so the products and the sum are integers throughout, a reduction the C compiler
      // may vectorize; docs/int32_codegen_design.md "Bounded bitwise results")
      for (let j = 0; j < 32; j++) { const a = (q[qb + j] << 24) >> 24, b = (xq[xb + j] << 24) >> 24; isum = (isum + a * b) | 0; }
      s += F16[u[p] | (u[p + 1] << 8)] * xs[b] * isum;
      p += 34;
    }
    out[r] = s;
  }
}
/** out = W x for a Q4_0 weight (the nibbles, minus 8). */
function matvecQ4(m: Model, w: Weight, xq: Int8Array, xs: Float32Array, out: Float32Array): void {
  const u = w.bytes;
  const n = w.cols | 0, rows = w.rows | 0, nb = n >> 5;
  const rowBytes = nb * 18;
  for (let r = 0; r < rows; r++) {
    let s = 0;
    let p = Math.imul(r, rowBytes);
    for (let b = 0; b < nb; b++) {
      const qb = p + 2, xb = b << 5;
      let isum = 0;
      for (let j = 0; j < 16; j++) {
        const byte = u[qb + j];
        const lo = (xq[xb + j] << 24) >> 24, hi = (xq[xb + j + 16] << 24) >> 24;
        isum = (isum + ((byte & 15) - 8) * lo + ((byte >> 4) - 8) * hi) | 0;
      }
      s += F16[u[p] | (u[p + 1] << 8)] * xs[b] * isum;
      p += 18;
    }
    out[r] = s;
  }
}
/** out = W x for an F32 or F16 weight. */
function matvecFloat(m: Model, w: Weight, x: Float32Array, out: Float32Array): void {
  const n = w.cols | 0, rows = w.rows | 0;
  if (w.type === GGML_F32) {
    const f = w.f32;
    for (let r = 0; r < rows; r++) {
      const base = Math.imul(r, n);
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let j = 0; j < n; j += 4) { s0 += f[base + j] * x[j]; s1 += f[base + j + 1] * x[j + 1]; s2 += f[base + j + 2] * x[j + 2]; s3 += f[base + j + 3] * x[j + 3]; }
      out[r] = (s0 + s1) + (s2 + s3);
    }
  } else {
    const u = w.bytes;
    for (let r = 0; r < rows; r++) {
      let p = Math.imul(r, n * 2);
      let s = 0;
      for (let j = 0; j < n; j++) { s += F16[u[p] | (u[p + 1] << 8)] * x[j]; p += 2; }
      out[r] = s;
    }
  }
}
function rmsnorm(o: Float32Array, x: Float32Array, w: Float32Array, size: number, eps: number): void {
  let ss = 0;
  for (let j = 0; j < size; j++) ss += x[j] * x[j];
  ss = 1 / Math.sqrt(ss / size + eps);
  for (let j = 0; j < size; j++) o[j] = w[j] * (ss * x[j]);
}
function softmax(x: Float32Array, off: number, size: number): void {
  let maxVal = x[off];
  for (let i = 1; i < size; i++) if (x[off + i] > maxVal) maxVal = x[off + i];
  let sum = 0;
  for (let i = 0; i < size; i++) { const e = Math.exp(x[off + i] - maxVal); x[off + i] = e; sum += e; }
  for (let i = 0; i < size; i++) x[off + i] = x[off + i] / sum;
}

// ---------------------------------------------------------------- the model
interface Layer { attnNorm: Float32Array; wq: Weight; wk: Weight; wv: Weight; wo: Weight; ffnNorm: Float32Array; w1: Weight; w2: Weight; w3: Weight }
class Llama {
  readonly m: Model;
  readonly nEmbd: number; readonly nLayer: number; readonly nFf: number; readonly nHead: number; readonly nHeadKv: number;
  readonly headSize: number; readonly kvDim: number; readonly kvMul: number; readonly ctx: number; readonly vocab: number;
  readonly eps: number; readonly ropeBase: number;
  readonly layers: Layer[] = [];
  readonly tokEmbd: Weight; readonly outNorm: Float32Array; readonly output: Weight;
  // the run state
  readonly x: Float32Array; readonly xb: Float32Array; readonly xb2: Float32Array; readonly hb: Float32Array; readonly hb2: Float32Array;
  readonly q: Float32Array; readonly att: Float32Array; readonly logits: Float32Array;
  readonly xq: Int8Array; readonly xs: Float32Array; readonly hq: Int8Array; readonly hs: Float32Array;
  readonly keyCache: Float32Array; readonly valueCache: Float32Array;
  constructor(m: Model, ctxLimit: number) {
    this.m = m;
    const kv = m.g.kv;
    const arch = kv.get("general.architecture") as string;
    if (arch !== "llama") throw new Error(`architecture ${arch} not supported (llama only)`);
    const num = (k: string): number => { const v = kv.get(k); if (typeof v !== "number") throw new Error(`metadata ${k} missing`); return v; };
    this.nEmbd = num("llama.embedding_length"); this.nLayer = num("llama.block_count"); this.nFf = num("llama.feed_forward_length");
    this.nHead = num("llama.attention.head_count");
    this.nHeadKv = kv.has("llama.attention.head_count_kv") ? num("llama.attention.head_count_kv") : this.nHead;
    this.eps = kv.has("llama.attention.layer_norm_rms_epsilon") ? num("llama.attention.layer_norm_rms_epsilon") : 1e-5;
    this.ropeBase = kv.has("llama.rope.freq_base") ? num("llama.rope.freq_base") : 10000;
    this.ctx = Math.min(num("llama.context_length"), ctxLimit);
    this.headSize = this.nEmbd / this.nHead;
    this.kvDim = this.headSize * this.nHeadKv;
    this.kvMul = this.nHead / this.nHeadKv;
    this.tokEmbd = m.weight("token_embd.weight");
    this.vocab = this.tokEmbd.rows;
    const normOf = (name: string): Float32Array => { const w = m.weight(name); const out = new Float32Array(w.cols); m.row(w, 0, out); return out; };
    this.outNorm = normOf("output_norm.weight");
    this.output = m.g.tensors.has("output.weight") ? m.weight("output.weight") : this.tokEmbd;
    for (let l = 0; l < this.nLayer; l++) {
      const p = `blk.${l}.`;
      this.layers.push({
        attnNorm: normOf(p + "attn_norm.weight"), wq: m.weight(p + "attn_q.weight"), wk: m.weight(p + "attn_k.weight"), wv: m.weight(p + "attn_v.weight"), wo: m.weight(p + "attn_output.weight"),
        ffnNorm: normOf(p + "ffn_norm.weight"), w1: m.weight(p + "ffn_gate.weight"), w2: m.weight(p + "ffn_down.weight"), w3: m.weight(p + "ffn_up.weight"),
      });
    }
    const d = this.nEmbd, ff = this.nFf;
    this.x = new Float32Array(d); this.xb = new Float32Array(d); this.xb2 = new Float32Array(d);
    this.hb = new Float32Array(ff); this.hb2 = new Float32Array(ff);
    this.q = new Float32Array(d); this.att = new Float32Array(this.nHead * this.ctx); this.logits = new Float32Array(this.vocab);
    this.xq = new Int8Array(d); this.xs = new Float32Array(d >> 5); this.hq = new Int8Array(ff); this.hs = new Float32Array(ff >> 5);
    this.keyCache = new Float32Array(this.nLayer * this.ctx * this.kvDim);
    this.valueCache = new Float32Array(this.nLayer * this.ctx * this.kvDim);
  }
  /** out = W x, by the weight's quantization; the int8 form of x is computed once per call site. */
  private matvec(w: Weight, x: Float32Array, xq: Int8Array, xs: Float32Array, quantized: boolean, out: Float32Array): void {
    if (w.type === GGML_Q8_0) { if (!quantized) quantizeQ8(x, w.cols, xq, xs); matvecQ8(this.m, w, xq, xs, out); }
    else if (w.type === GGML_Q4_0) { if (!quantized) quantizeQ8(x, w.cols, xq, xs); matvecQ4(this.m, w, xq, xs, out); }
    else matvecFloat(this.m, w, x, out);
  }
  forward(token: number, pos: number): Float32Array {
    const d = this.nEmbd | 0, ff = this.nFf | 0, kvDim = this.kvDim | 0, kvMul = this.kvMul | 0, hs = this.headSize | 0, ctx = this.ctx | 0, nHead = this.nHead | 0;
    const x = this.x, xb = this.xb, xb2 = this.xb2, hb = this.hb, hb2 = this.hb2, q = this.q, att = this.att, kc = this.keyCache, vc = this.valueCache;
    const xq = this.xq, xs = this.xs, hq = this.hq, hsc = this.hs;
    this.m.row(this.tokEmbd, token, x);
    for (let l = 0; l < this.nLayer; l++) {
      const L = this.layers[l];
      rmsnorm(xb, x, L.attnNorm, d, this.eps);
      const loff = l * ctx * kvDim, kOff = loff + pos * kvDim;
      quantizeQ8(xb, d, xq, xs);
      this.matvec(L.wq, xb, xq, xs, true, q);
      this.matvec(L.wk, xb, xq, xs, true, xb2);
      for (let i = 0; i < kvDim; i++) kc[kOff + i] = xb2[i];
      this.matvec(L.wv, xb, xq, xs, true, xb2);
      for (let i = 0; i < kvDim; i++) vc[kOff + i] = xb2[i];
      // RoPE, adjacent pairs (the converter permuted q and k for it)
      for (let i = 0; i < d; i += 2) {
        const headDim = i % hs;
        const freq = 1 / Math.pow(this.ropeBase, headDim / hs);
        const val = pos * freq;
        const fcr = Math.cos(val), fci = Math.sin(val);
        const q0 = q[i], q1 = q[i + 1];
        q[i] = q0 * fcr - q1 * fci;
        q[i + 1] = q0 * fci + q1 * fcr;
        if (i < kvDim) {
          const k0 = kc[kOff + i], k1 = kc[kOff + i + 1];
          kc[kOff + i] = k0 * fcr - k1 * fci;
          kc[kOff + i + 1] = k0 * fci + k1 * fcr;
        }
      }
      const scale = 1 / Math.sqrt(hs);
      for (let h = 0; h < nHead; h++) {
        const qOff = h * hs, attOff = h * ctx, kvHeadOff = ((h / kvMul) | 0) * hs;
        for (let t = 0; t <= pos; t++) {
          const kt = loff + t * kvDim + kvHeadOff;
          let score = 0;
          for (let i = 0; i < hs; i++) score += q[qOff + i] * kc[kt + i];
          att[attOff + t] = score * scale;
        }
        softmax(att, attOff, pos + 1);
        for (let i = 0; i < hs; i++) xb[qOff + i] = 0;
        for (let t = 0; t <= pos; t++) {
          const vt = loff + t * kvDim + kvHeadOff;
          const a = att[attOff + t];
          for (let i = 0; i < hs; i++) xb[qOff + i] += a * vc[vt + i];
        }
      }
      this.matvec(L.wo, xb, xq, xs, false, xb2);
      for (let i = 0; i < d; i++) x[i] += xb2[i];
      rmsnorm(xb, x, L.ffnNorm, d, this.eps);
      quantizeQ8(xb, d, xq, xs);
      this.matvec(L.w1, xb, xq, xs, true, hb);
      this.matvec(L.w3, xb, xq, xs, true, hb2);
      for (let i = 0; i < ff; i++) { const v = hb[i]; hb[i] = v * (1 / (1 + Math.exp(-v))) * hb2[i]; }
      this.matvec(L.w2, hb, hq, hsc, false, xb);
      for (let i = 0; i < d; i++) x[i] += xb[i];
    }
    rmsnorm(x, x, this.outNorm, d, this.eps);
    this.matvec(this.output, x, xq, xs, false, this.logits);
    return this.logits;
  }
}

// ---------------------------------------------------------------- the tokenizer (SentencePiece BPE from the file)
class Tokenizer {
  readonly tokens: string[];
  readonly scores: number[];
  readonly types: number[];
  readonly index = new Map<string, number>();
  readonly bos: number; readonly eos: number;
  private readonly byteTokens = new Map<number, number>();
  constructor(kv: Map<string, unknown>) {
    this.tokens = kv.get("tokenizer.ggml.tokens") as string[];
    this.scores = (kv.get("tokenizer.ggml.scores") as number[] | undefined) ?? [];
    this.types = (kv.get("tokenizer.ggml.token_type") as number[] | undefined) ?? [];
    this.bos = (kv.get("tokenizer.ggml.bos_token_id") as number | undefined) ?? 1;
    this.eos = (kv.get("tokenizer.ggml.eos_token_id") as number | undefined) ?? 2;
    for (let i = 0; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (!this.index.has(t)) this.index.set(t, i);
      if (this.types[i] === 6 && t.length === 6 && t.startsWith("<0x")) this.byteTokens.set(parseInt(t.slice(3, 5), 16), i);
    }
  }
  /** The pieces of `text`: a dummy prefix space, spaces as the SentencePiece marker, code points, merges by score, byte fallback. */
  encode(text: string, bos: boolean): number[] {
    const out: number[] = [];
    if (bos) out.push(this.bos);
    if (text.length === 0) return out;
    const marked = "▁" + text.replace(/ /g, "▁");
    const tokens: number[] = [];
    for (const ch of marked) {
      const id = this.index.get(ch);
      if (id !== undefined) tokens.push(id);
      else {
        const bytes = new TextEncoder().encode(ch);
        for (let k = 0; k < bytes.length; k++) { const b = this.byteTokens.get(bytes[k]); tokens.push(b === undefined ? 0 : b); }
      }
    }
    for (;;) {
      let bestScore = -1e10, bestId = -1, bestIdx = -1;
      for (let k = 0; k + 1 < tokens.length; k++) {
        const id = this.index.get(this.tokens[tokens[k]] + this.tokens[tokens[k + 1]]);
        if (id !== undefined && this.scores[id] > bestScore) { bestScore = this.scores[id]; bestId = id; bestIdx = k; }
      }
      if (bestIdx === -1) break;
      tokens[bestIdx] = bestId;
      tokens.splice(bestIdx + 1, 1);
    }
    for (const t of tokens) out.push(t);
    return out;
  }
  /** The bytes of a token: the marker is a space, a byte token its byte, a control token nothing. */
  pieceBytes(token: number): Uint8Array {
    const t = this.tokens[token];
    if (this.types[token] === 6 && t.startsWith("<0x")) return new Uint8Array([parseInt(t.slice(3, 5), 16)]);
    if (this.types[token] === 3) return new Uint8Array(0);
    return new TextEncoder().encode(t.replace(/▁/g, " "));
  }
}

// ---------------------------------------------------------------- sampling and the program
class Sampler {
  private state: number;
  constructor(readonly temperature: number, seed: number) { this.state = (seed | 0) || 1; }
  private next(): number { let s = this.state; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.state = s; return (s >>> 0) / 4294967296; }
  sample(logits: Float32Array): number {
    const n = logits.length;
    if (this.temperature === 0) { let best = 0; for (let i = 1; i < n; i++) if (logits[i] > logits[best]) best = i; return best; }
    for (let i = 0; i < n; i++) logits[i] = logits[i] / this.temperature;
    softmax(logits, 0, n);
    const coin = this.next();
    let cdf = 0;
    for (let i = 0; i < n; i++) { cdf += logits[i]; if (coin < cdf) return i; }
    return n - 1;
  }
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) { process.stderr.write("usage: llama_gguf <model.gguf> [-n steps] [-p prompt] [-t temperature] [-s seed] [--raw]\n"); process.exit(1); }
  let steps = 64, prompt = "Tell me a short story about a robot.", temperature = 0, seed = 42, raw = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") raw = true;
    else if (i + 1 < args.length) {
      const v = args[++i];
      if (a === "-n") steps = parseInt(v, 10); else if (a === "-p") prompt = v; else if (a === "-t") temperature = parseFloat(v); else if (a === "-s") seed = parseInt(v, 10);
    }
  }
  const t0 = Date.now();
  const g = readGguf(args[0]);
  const model = new Model(g);
  const llama = new Llama(model, 2048);
  const tok = new Tokenizer(g.kv);
  const sampler = new Sampler(temperature, seed);
  process.stderr.write(`model: ${g.kv.get("general.name")} (${llama.nLayer} layers, ${llama.nEmbd} dim, ${llama.nHead}/${llama.nHeadKv} heads, ${llama.vocab} vocab), loaded in ${Date.now() - t0} ms\n`);
  // TinyLlama-Chat's template (Zephyr): the literal "</s>" is the eos token
  let promptTokens: number[];
  if (raw) promptTokens = tok.encode(prompt, true);
  else {
    promptTokens = tok.encode("<|system|>\nYou are a friendly chatbot who always responds in the style of a pirate.", true);
    promptTokens.push(tok.eos);
    for (const t of tok.encode("\n<|user|>\n" + prompt, false)) promptTokens.push(t);
    promptTokens.push(tok.eos);
    for (const t of tok.encode("\n<|assistant|>\n", false)) promptTokens.push(t);
  }
  const pieces: Uint8Array[] = [];
  let token = promptTokens[0], pos = 0, generated = 0;
  const start = Date.now();
  let promptMs = 0;
  while (pos < llama.ctx && generated < steps) {
    const logits = llama.forward(token, pos);
    let next: number;
    if (pos < promptTokens.length - 1) next = promptTokens[pos + 1];
    else {
      if (generated === 0) promptMs = Date.now() - start;
      next = sampler.sample(logits);
      generated++;
      if (next === tok.eos) break;
      pieces.push(tok.pieceBytes(next));
    }
    pos++;
    token = next;
  }
  const text = new TextDecoder().decode(concatBytes(pieces));
  process.stdout.write(text + "\n");
  const genMs = Date.now() - start - promptMs;
  process.stderr.write(`prompt ${promptTokens.length} tokens in ${promptMs} ms (${(promptTokens.length / (promptMs / 1000)).toFixed(1)} tok/s), generated ${generated} tokens in ${genMs} ms (${(generated / (genMs / 1000)).toFixed(1)} tok/s)\n`);
}
main();
