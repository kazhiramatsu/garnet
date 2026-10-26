// llama2.ts: Llama 2 inference in TypeScript, a port of Andrej Karpathy's llama2.c (run.c, MIT):
// the fp32 checkpoints of the tinyllamas (stories15M, stories42M, stories110M) and their
// tokenizer.bin. The arithmetic is JavaScript's double over Float32Array storage (llama2.c
// computes in float), the sampling is argmax unless a temperature is given, so the generated
// text is a deterministic function of the model and the prompt, and garnet's output is compared
// with Node's running the same program (benchmarks/llama2/run.sh). The kernels are the flat
// typed-array loops garnet compiles to counted loops: matmul (a matrix-vector product per
// weight row), rmsnorm, softmax, RoPE, the attention over the key/value caches, SwiGLU.
//
// Usage: llama2 <checkpoint.bin> [-z tokenizer.bin] [-n steps] [-i "prompt"] [-t temperature] [-s seed]
import { readFileSync } from "node:fs";

interface Config {
  dim: number; hiddenDim: number; nLayers: number; nHeads: number; nKvHeads: number;
  vocabSize: number; seqLen: number; sharedWeights: boolean;
}
interface Weights {
  tokenEmbedding: Float32Array; rmsAtt: Float32Array; wq: Float32Array; wk: Float32Array; wv: Float32Array;
  wo: Float32Array; rmsFfn: Float32Array; w1: Float32Array; w2: Float32Array; w3: Float32Array;
  rmsFinal: Float32Array; wcls: Float32Array;
}

// ---------------------------------------------------------------- the checkpoint
function readCheckpoint(path: string): { config: Config; weights: Weights } {
  const file = readFileSync(path);
  const bytes = new Uint8Array(file.length);
  bytes.set(file);                                   // a fresh, aligned buffer of the whole file
  const header = new Int32Array(bytes.buffer, 0, 7);
  const sharedWeights = header[5] > 0;
  const config: Config = {
    dim: header[0], hiddenDim: header[1], nLayers: header[2], nHeads: header[3], nKvHeads: header[4],
    vocabSize: Math.abs(header[5]), seqLen: header[6], sharedWeights,
  };
  const f = new Float32Array(bytes.buffer, 28, (bytes.length - 28) >> 2);
  const c = config;
  const headSize = c.dim / c.nHeads;
  let off = 0;
  const take = (n: number): Float32Array => { const v = f.subarray(off, off + n); off += n; return v; };
  const tokenEmbedding = take(c.vocabSize * c.dim);
  const rmsAtt = take(c.nLayers * c.dim);
  const wq = take(c.nLayers * c.dim * c.nHeads * headSize);
  const wk = take(c.nLayers * c.dim * c.nKvHeads * headSize);
  const wv = take(c.nLayers * c.dim * c.nKvHeads * headSize);
  const wo = take(c.nLayers * c.nHeads * headSize * c.dim);
  const rmsFfn = take(c.nLayers * c.dim);
  const w1 = take(c.nLayers * c.dim * c.hiddenDim);
  const w2 = take(c.nLayers * c.hiddenDim * c.dim);
  const w3 = take(c.nLayers * c.dim * c.hiddenDim);
  const rmsFinal = take(c.dim);
  off += c.seqLen * headSize;                        // the legacy RoPE tables (freq_cis_real, freq_cis_imag)
  const wcls = sharedWeights ? tokenEmbedding : take(c.vocabSize * c.dim);
  return { config, weights: { tokenEmbedding, rmsAtt, wq, wk, wv, wo, rmsFfn, w1, w2, w3, rmsFinal, wcls } };
}

// ---------------------------------------------------------------- the kernels
/** out = W x for W of d rows and n columns at wOff (row-major). Four partial sums keep four
 *  multiply-add chains in flight (a floating-point reduction is not reassociated by the
 *  compiler); the order of additions is fixed, so Node computes the same values. */
function matmul(out: Float32Array, x: Float32Array, w: Float32Array, wOff: number, n: number, d: number): void {
  const n4 = n & ~3;
  for (let i = 0; i < d; i++) {
    const row = wOff + i * n;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let j = 0; j < n4; j += 4) {
      s0 += w[row + j] * x[j];
      s1 += w[row + j + 1] * x[j + 1];
      s2 += w[row + j + 2] * x[j + 2];
      s3 += w[row + j + 3] * x[j + 3];
    }
    let s = (s0 + s1) + (s2 + s3);
    for (let j = n4; j < n; j++) s += w[row + j] * x[j];
    out[i] = s;
  }
}
function rmsnorm(o: Float32Array, x: Float32Array, w: Float32Array, wOff: number, size: number): void {
  let ss = 0;
  for (let j = 0; j < size; j++) ss += x[j] * x[j];
  ss = ss / size + 1e-5;
  ss = 1 / Math.sqrt(ss);
  for (let j = 0; j < size; j++) o[j] = w[wOff + j] * (ss * x[j]);
}
function softmax(x: Float32Array, off: number, size: number): void {
  let maxVal = x[off];
  for (let i = 1; i < size; i++) if (x[off + i] > maxVal) maxVal = x[off + i];
  let sum = 0;
  for (let i = 0; i < size; i++) { const e = Math.exp(x[off + i] - maxVal); x[off + i] = e; sum += e; }
  for (let i = 0; i < size; i++) x[off + i] = x[off + i] / sum;
}

class Transformer {
  readonly config: Config;
  readonly w: Weights;
  // the run state
  readonly x: Float32Array; readonly xb: Float32Array; readonly xb2: Float32Array;
  readonly hb: Float32Array; readonly hb2: Float32Array; readonly q: Float32Array;
  readonly att: Float32Array; readonly logits: Float32Array;
  readonly keyCache: Float32Array; readonly valueCache: Float32Array;
  readonly kvDim: number; readonly kvMul: number; readonly headSize: number;
  constructor(path: string) {
    const { config, weights } = readCheckpoint(path);
    this.config = config; this.w = weights;
    const c = config;
    this.kvDim = (c.dim * c.nKvHeads) / c.nHeads;
    this.kvMul = c.nHeads / c.nKvHeads;
    this.headSize = c.dim / c.nHeads;
    this.x = new Float32Array(c.dim); this.xb = new Float32Array(c.dim); this.xb2 = new Float32Array(c.dim);
    this.hb = new Float32Array(c.hiddenDim); this.hb2 = new Float32Array(c.hiddenDim);
    this.q = new Float32Array(c.dim);
    this.att = new Float32Array(c.nHeads * c.seqLen);
    this.logits = new Float32Array(c.vocabSize);
    this.keyCache = new Float32Array(c.nLayers * c.seqLen * this.kvDim);
    this.valueCache = new Float32Array(c.nLayers * c.seqLen * this.kvDim);
  }
  /** The logits for `token` at position `pos` (the caches hold the positions before it). */
  forward(token: number, pos: number): Float32Array {
    const c = this.config, w = this.w;
    const dim = c.dim | 0, hiddenDim = c.hiddenDim | 0, kvDim = this.kvDim | 0, kvMul = this.kvMul | 0, headSize = this.headSize | 0;
    const seqLen = c.seqLen | 0, nHeads = c.nHeads | 0;
    const x = this.x, xb = this.xb, xb2 = this.xb2, hb = this.hb, hb2 = this.hb2, q = this.q, att = this.att;
    const kc = this.keyCache, vc = this.valueCache;
    // the token's embedding
    const emb = token * dim;
    for (let i = 0; i < dim; i++) x[i] = w.tokenEmbedding[emb + i];
    for (let l = 0; l < c.nLayers; l++) {
      rmsnorm(xb, x, w.rmsAtt, l * dim, dim);
      const loff = l * seqLen * kvDim;
      const kOff = loff + pos * kvDim;                 // this position's key and value rows in the caches
      matmul(q, xb, w.wq, l * dim * dim, dim, dim);
      // the key and value rows are written into the caches directly
      for (let i = 0; i < kvDim; i++) {
        const rowK = l * dim * kvDim + i * dim, rowV = rowK;
        let sk = 0, sv = 0;
        for (let j = 0; j < dim; j++) { sk += w.wk[rowK + j] * xb[j]; sv += w.wv[rowV + j] * xb[j]; }
        kc[kOff + i] = sk; vc[kOff + i] = sv;
      }
      // RoPE on q and k
      for (let i = 0; i < dim; i += 2) {
        const headDim = i % headSize;
        const freq = 1 / Math.pow(10000, headDim / headSize);
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
      // multi-head attention over the positions so far
      const scale = 1 / Math.sqrt(headSize);
      for (let h = 0; h < nHeads; h++) {
        const qOff = h * headSize, attOff = h * seqLen;
        const kvHeadOff = ((h / kvMul) | 0) * headSize;
        for (let t = 0; t <= pos; t++) {
          const kt = loff + t * kvDim + kvHeadOff;
          let score = 0;
          for (let i = 0; i < headSize; i++) score += q[qOff + i] * kc[kt + i];
          att[attOff + t] = score * scale;
        }
        softmax(att, attOff, pos + 1);
        for (let i = 0; i < headSize; i++) xb[qOff + i] = 0;
        for (let t = 0; t <= pos; t++) {
          const vt = loff + t * kvDim + kvHeadOff;
          const a = att[attOff + t];
          for (let i = 0; i < headSize; i++) xb[qOff + i] += a * vc[vt + i];
        }
      }
      matmul(xb2, xb, w.wo, l * dim * dim, dim, dim);
      for (let i = 0; i < dim; i++) x[i] += xb2[i];
      // the feed-forward network: SwiGLU
      rmsnorm(xb, x, w.rmsFfn, l * dim, dim);
      matmul(hb, xb, w.w1, l * dim * hiddenDim, dim, hiddenDim);
      matmul(hb2, xb, w.w3, l * dim * hiddenDim, dim, hiddenDim);
      for (let i = 0; i < hiddenDim; i++) {
        let v = hb[i];
        v = v * (1 / (1 + Math.exp(-v)));
        hb[i] = v * hb2[i];
      }
      matmul(xb, hb, w.w2, l * dim * hiddenDim, hiddenDim, dim);
      for (let i = 0; i < dim; i++) x[i] += xb[i];
    }
    rmsnorm(x, x, w.rmsFinal, 0, dim);
    matmul(this.logits, x, w.wcls, 0, dim, c.vocabSize);
    return this.logits;
  }
}

// ---------------------------------------------------------------- the tokenizer
class Tokenizer {
  readonly vocab: string[] = [];
  readonly scores: number[] = [];
  readonly index = new Map<string, number>();
  readonly maxTokenLength: number;
  private readonly decoder = new TextDecoder();
  constructor(path: string, vocabSize: number) {
    const file = readFileSync(path);
    const b = new Uint8Array(file.length);
    b.set(file);
    const scratch = new ArrayBuffer(4), su = new Uint8Array(scratch), sf = new Float32Array(scratch), si = new Int32Array(scratch);
    const i32 = (o: number): number => { su[0] = b[o]; su[1] = b[o + 1]; su[2] = b[o + 2]; su[3] = b[o + 3]; return si[0]; };
    const f32 = (o: number): number => { su[0] = b[o]; su[1] = b[o + 1]; su[2] = b[o + 2]; su[3] = b[o + 3]; return sf[0]; };
    this.maxTokenLength = i32(0);
    let o = 4;
    for (let i = 0; i < vocabSize; i++) {
      const score = f32(o); o += 4;
      const len = i32(o); o += 4;
      const s = this.decoder.decode(b.subarray(o, o + len)); o += len;
      this.vocab.push(s);
      this.scores.push(score);
      if (!this.index.has(s)) this.index.set(s, i);
    }
  }
  /** The text of `token` after `prev` (the space after BOS dropped, byte tokens as their byte). */
  decode(prev: number, token: number): string {
    let piece = this.vocab[token];
    if (prev === 1 && piece.charCodeAt(0) === 32) piece = piece.slice(1);
    if (piece.length === 6 && piece.startsWith("<0x") && piece.endsWith(">")) {
      const byte = parseInt(piece.slice(3, 5), 16);
      // llama2.c prints only printable bytes and whitespace
      return (byte >= 32 && byte < 127) || byte === 10 || byte === 9 || byte === 13 ? String.fromCharCode(byte) : "";
    }
    return piece;
  }
  /** SentencePiece-style BPE as llama2.c does it: a dummy prefix space, the code points, then the best merges. */
  encode(text: string, bos: boolean, eos: boolean): number[] {
    const tokens: number[] = [];
    if (bos) tokens.push(1);
    if (text.length > 0) tokens.push(this.index.get(" ") as number);
    const bytes = new TextEncoder().encode(text);
    let i = 0;
    while (i < bytes.length) {
      let n = 1;
      while (i + n < bytes.length && (bytes[i + n] & 0xc0) === 0x80 && n < 4) n++;
      const s = this.decoder.decode(bytes.subarray(i, i + n));
      const id = this.index.get(s);
      if (id !== undefined) tokens.push(id);
      else for (let k = 0; k < n; k++) tokens.push(bytes[i + k] + 3);   // byte fallback: <0x00> is token 3
      i += n;
    }
    for (;;) {
      let bestScore = -1e10, bestId = -1, bestIdx = -1;
      for (let k = 0; k + 1 < tokens.length; k++) {
        const id = this.index.get(this.vocab[tokens[k]] + this.vocab[tokens[k + 1]]);
        if (id !== undefined && this.scores[id] > bestScore) { bestScore = this.scores[id]; bestId = id; bestIdx = k; }
      }
      if (bestIdx === -1) break;
      tokens[bestIdx] = bestId;
      tokens.splice(bestIdx + 1, 1);
    }
    if (eos) tokens.push(2);
    return tokens;
  }
}

// ---------------------------------------------------------------- sampling
class Sampler {
  private state: number;
  constructor(readonly temperature: number, seed: number) { this.state = (seed | 0) || 1; }
  private next(): number {        // xorshift32, a double in [0, 1)
    let s = this.state;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.state = s;
    return (s >>> 0) / 4294967296;
  }
  sample(logits: Float32Array): number {
    const n = logits.length;
    if (this.temperature === 0) {
      let best = 0;
      for (let i = 1; i < n; i++) if (logits[i] > logits[best]) best = i;
      return best;
    }
    for (let i = 0; i < n; i++) logits[i] = logits[i] / this.temperature;
    softmax(logits, 0, n);
    const coin = this.next();
    let cdf = 0;
    for (let i = 0; i < n; i++) { cdf += logits[i]; if (coin < cdf) return i; }
    return n - 1;
  }
}

// ---------------------------------------------------------------- the program
function generate(t: Transformer, tok: Tokenizer, sampler: Sampler, prompt: string, steps: number): void {
  const promptTokens = tok.encode(prompt, true, false);
  let token = promptTokens[0];
  let pos = 0;
  const start = Date.now();
  let out = "";
  while (pos < steps) {
    const logits = t.forward(token, pos);
    const next = pos < promptTokens.length - 1 ? promptTokens[pos + 1] : sampler.sample(logits);
    pos++;
    if (next === 1) break;
    const piece = tok.decode(token, next);
    process.stdout.write(piece);
    out += piece;
    token = next;
  }
  process.stdout.write("\n");
  const ms = Date.now() - start;
  if (pos > 1) process.stderr.write(`achieved tok/s: ${((pos - 1) / (ms / 1000)).toFixed(1)} (${pos - 1} tokens, ${ms} ms)\n`);
}
function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) { process.stderr.write("usage: llama2 <checkpoint.bin> [-z tokenizer.bin] [-n steps] [-i prompt] [-t temperature] [-s seed]\n"); process.exit(1); }
  const checkpoint = args[0];
  let tokenizerPath = checkpoint.slice(0, checkpoint.lastIndexOf("/") + 1) + "tokenizer.bin";
  let steps = 256, prompt = "", temperature = 0, seed = 42;
  for (let i = 1; i + 1 < args.length; i += 2) {
    const flag = args[i], v = args[i + 1];
    if (flag === "-z") tokenizerPath = v;
    else if (flag === "-n") steps = parseInt(v, 10);
    else if (flag === "-i") prompt = v;
    else if (flag === "-t") temperature = parseFloat(v);
    else if (flag === "-s") seed = parseInt(v, 10);
  }
  const t = new Transformer(checkpoint);
  if (steps <= 0 || steps > t.config.seqLen) steps = t.config.seqLen;
  const tok = new Tokenizer(tokenizerPath, t.config.vocabSize);
  generate(t, tok, new Sampler(temperature, seed), prompt, steps);
}
main();
