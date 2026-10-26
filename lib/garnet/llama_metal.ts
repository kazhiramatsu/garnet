// garnet:llama_metal — the GPU path of garnet:llama over garnet:metal (docs/llm_inference_design.md,
// milestone 3). `llama.gpu = new LlamaMetal(llama)` runs every forward pass on the Metal device:
// the model's bytes (read into a SharedArrayBuffer, `readGguf(path, true)`) and the run state
// (the activations, the KV cache, the logits: SharedArrayBuffers of the Llama) are GPU buffers
// without a copy, and a token is one command buffer of ten kernels per layer, one commit and
// one wait: RMSNorm; the q, k and v products (k and v straight into the caches at the
// position); RoPE on q and k; the attention over the heads; the output product added to the
// residual; RMSNorm; the gate and up products with SiLU in one kernel; the down product added to
// the residual; then the final norm and the vocabulary product into the logits. The token's
// embedding is written by the CPU before the commit; the sampling reads the logits after the
// wait. The products read the quantized rows as llama.cpp's Metal kernels do: a SIMD group per
// two rows, each lane a quarter of every eighth block, the int8 (or nibble) weights times the
// float activation (no int8 quantization of the activation on the GPU), the block scale applied
// per block, a simd_sum at the end. The arithmetic is float32 in the GPU's order, so the logits
// differ from the CPU path's in their low bits; `benchmarks/llama2/llama_gguf.ts --check-gpu`
// compares the two over the prompt (the argmax per position, the last logits within a
// tolerance). Under Node, garnet:metal is absent and the constructor throws.
import { Library, Pipeline, GpuBuffer, CommandBuffer, available, deviceName } from "garnet:metal";
import { Llama, Weight, GGML_F32, GGML_F16, GGML_Q8_0, GGML_Q4_0 } from "./llama";
import { performance } from "node:perf_hooks";

const NSG = 4, NR = 2;                      // SIMD groups per threadgroup, rows per SIMD group
const MV_ROWS = NSG * NR, MV_THREADS = NSG * 32;
const NORM_THREADS = 256, ATTN_THREADS = 256;

/** the kernels' source (exported for probes and tests) */
export const KERNEL_SOURCE = `#include <metal_stdlib>
using namespace metal;
#define NSG ${NSG}
#define NR ${NR}
#define NT ${NORM_THREADS}
struct MvArgs { uint off; uint off2; uint rows; uint cols; uint flags; uint outOff; };
struct NormArgs { uint n; float eps; uint wOff; };
struct RopeArgs { uint d; uint kvDim; uint hs; uint ropeOff; uint kOff; };
struct AttnArgs { uint pos; uint hs; uint kvDim; uint kvMul; uint ctx; uint loff; float scale; };

// the row's value: flags 2 = silu(v) * v2 (the gate and up products), flags 1 = added to out
static inline void mv_store(device float* out, constant MvArgs& a, uint row, float v, float v2, uint tiisg) {
  if (a.flags & 2u) v = v / (1.0f + exp(-v)) * v2;
  if (tiisg == 0u) { if (a.flags & 1u) out[a.outOff + row] += v; else out[a.outOff + row] = v; }
}

// Q8_0: blocks of 2 bytes (f16 scale) + 32 int8; a lane handles 8 weights of every eighth block
kernel void matvec_q8(device const char* model [[buffer(0)]], device const float* x [[buffer(1)]],
                      device float* out [[buffer(2)]], constant MvArgs& a [[buffer(3)]],
                      uint tgpig [[threadgroup_position_in_grid]], uint tiisg [[thread_index_in_simdgroup]],
                      uint sgitg [[simdgroup_index_in_threadgroup]]) {
  const uint nb = a.cols >> 5, rowBytes = nb * 34u;
  const uint first = (tgpig * NSG + sgitg) * NR;
  if (first >= a.rows) return;
  const uint ix = tiisg >> 2, il = tiisg & 3u;
  const bool two = (a.flags & 2u) != 0u;
  device const char* w = model + a.off + first * rowBytes;
  device const char* w2 = model + a.off2 + first * rowBytes;
  float sum[NR], sum2[NR];
  for (uint r = 0; r < NR; r++) { sum[r] = 0.0f; sum2[r] = 0.0f; }
  for (uint ib = ix; ib < nb; ib += 8u) {
    float yl[8];
    device const float* xp = x + ib * 32u + il * 8u;
    for (uint i = 0; i < 8u; i++) yl[i] = xp[i];
    for (uint r = 0; r < NR; r++) {
      device const char* blk = w + r * rowBytes + ib * 34u;
      const float d = (float)(*(device const half*)blk);
      device const char* q = blk + 2u + il * 8u;
      float s = 0.0f;
      for (uint i = 0; i < 8u; i++) s += (float)q[i] * yl[i];
      sum[r] += d * s;
      if (two) {
        device const char* blk2 = w2 + r * rowBytes + ib * 34u;
        const float d2 = (float)(*(device const half*)blk2);
        device const char* q2 = blk2 + 2u + il * 8u;
        float s2 = 0.0f;
        for (uint i = 0; i < 8u; i++) s2 += (float)q2[i] * yl[i];
        sum2[r] += d2 * s2;
      }
    }
  }
  for (uint r = 0; r < NR; r++) {
    const float v = simd_sum(sum[r]);
    const float v2 = two ? simd_sum(sum2[r]) : 0.0f;
    if (first + r < a.rows) mv_store(out, a, first + r, v, v2, tiisg);
  }
}

// Q4_0: blocks of 2 bytes (f16 scale) + 16 bytes; the low nibbles are weights 0-15, the high 16-31, minus 8
kernel void matvec_q4(device const char* model [[buffer(0)]], device const float* x [[buffer(1)]],
                      device float* out [[buffer(2)]], constant MvArgs& a [[buffer(3)]],
                      uint tgpig [[threadgroup_position_in_grid]], uint tiisg [[thread_index_in_simdgroup]],
                      uint sgitg [[simdgroup_index_in_threadgroup]]) {
  const uint nb = a.cols >> 5, rowBytes = nb * 18u;
  const uint first = (tgpig * NSG + sgitg) * NR;
  if (first >= a.rows) return;
  const uint ix = tiisg >> 2, il = tiisg & 3u;
  const uint sh = (il >> 1) * 4u, qo = 2u + (il & 1u) * 8u;
  const bool two = (a.flags & 2u) != 0u;
  device const char* w = model + a.off + first * rowBytes;
  device const char* w2 = model + a.off2 + first * rowBytes;
  float sum[NR], sum2[NR];
  for (uint r = 0; r < NR; r++) { sum[r] = 0.0f; sum2[r] = 0.0f; }
  for (uint ib = ix; ib < nb; ib += 8u) {
    float yl[8];
    device const float* xp = x + ib * 32u + il * 8u;
    for (uint i = 0; i < 8u; i++) yl[i] = xp[i];
    for (uint r = 0; r < NR; r++) {
      device const char* blk = w + r * rowBytes + ib * 18u;
      const float d = (float)(*(device const half*)blk);
      device const uchar* q = (device const uchar*)(blk + qo);
      float s = 0.0f;
      for (uint i = 0; i < 8u; i++) s += (float)((int)((q[i] >> sh) & 0xFu) - 8) * yl[i];
      sum[r] += d * s;
      if (two) {
        device const char* blk2 = w2 + r * rowBytes + ib * 18u;
        const float d2 = (float)(*(device const half*)blk2);
        device const uchar* q2 = (device const uchar*)(blk2 + qo);
        float s2 = 0.0f;
        for (uint i = 0; i < 8u; i++) s2 += (float)((int)((q2[i] >> sh) & 0xFu) - 8) * yl[i];
        sum2[r] += d2 * s2;
      }
    }
  }
  for (uint r = 0; r < NR; r++) {
    const float v = simd_sum(sum[r]);
    const float v2 = two ? simd_sum(sum2[r]) : 0.0f;
    if (first + r < a.rows) mv_store(out, a, first + r, v, v2, tiisg);
  }
}

// F32 and F16 rows: a lane every 32nd column
kernel void matvec_f32(device const char* model [[buffer(0)]], device const float* x [[buffer(1)]],
                       device float* out [[buffer(2)]], constant MvArgs& a [[buffer(3)]],
                       uint tgpig [[threadgroup_position_in_grid]], uint tiisg [[thread_index_in_simdgroup]],
                       uint sgitg [[simdgroup_index_in_threadgroup]]) {
  const uint first = (tgpig * NSG + sgitg) * NR;
  if (first >= a.rows) return;
  const bool two = (a.flags & 2u) != 0u;
  device const float* w = (device const float*)(model + a.off) + first * a.cols;
  device const float* w2 = (device const float*)(model + a.off2) + first * a.cols;
  for (uint r = 0; r < NR; r++) {
    float s = 0.0f, s2 = 0.0f;
    for (uint j = tiisg; j < a.cols; j += 32u) { s += w[r * a.cols + j] * x[j]; if (two) s2 += w2[r * a.cols + j] * x[j]; }
    const float v = simd_sum(s);
    const float v2 = two ? simd_sum(s2) : 0.0f;
    if (first + r < a.rows) mv_store(out, a, first + r, v, v2, tiisg);
  }
}
kernel void matvec_f16(device const char* model [[buffer(0)]], device const float* x [[buffer(1)]],
                       device float* out [[buffer(2)]], constant MvArgs& a [[buffer(3)]],
                       uint tgpig [[threadgroup_position_in_grid]], uint tiisg [[thread_index_in_simdgroup]],
                       uint sgitg [[simdgroup_index_in_threadgroup]]) {
  const uint first = (tgpig * NSG + sgitg) * NR;
  if (first >= a.rows) return;
  const bool two = (a.flags & 2u) != 0u;
  device const half* w = (device const half*)(model + a.off) + first * a.cols;
  device const half* w2 = (device const half*)(model + a.off2) + first * a.cols;
  for (uint r = 0; r < NR; r++) {
    float s = 0.0f, s2 = 0.0f;
    for (uint j = tiisg; j < a.cols; j += 32u) { s += (float)w[r * a.cols + j] * x[j]; if (two) s2 += (float)w2[r * a.cols + j] * x[j]; }
    const float v = simd_sum(s);
    const float v2 = two ? simd_sum(s2) : 0.0f;
    if (first + r < a.rows) mv_store(out, a, first + r, v, v2, tiisg);
  }
}

// out = w * (x / sqrt(mean(x^2) + eps)), one threadgroup of NT threads (in place is fine)
kernel void rmsnorm(device const float* x [[buffer(0)]], device const float* w [[buffer(1)]],
                    device float* out [[buffer(2)]], constant NormArgs& a [[buffer(3)]],
                    uint tid [[thread_position_in_threadgroup]], uint tiisg [[thread_index_in_simdgroup]],
                    uint sgitg [[simdgroup_index_in_threadgroup]]) {
  threadgroup float part[NT / 32];
  float ss = 0.0f;
  for (uint j = tid; j < a.n; j += NT) ss += x[j] * x[j];
  ss = simd_sum(ss);
  if (tiisg == 0u) part[sgitg] = ss;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  float total = 0.0f;
  for (uint i = 0; i < NT / 32; i++) total += part[i];
  const float scale = 1.0f / sqrt(total / (float)a.n + a.eps);
  for (uint j = tid; j < a.n; j += NT) out[j] = w[a.wOff + j] * (scale * x[j]);
}

// RoPE over adjacent pairs of q and of the key at kOff, the angles from the tables at ropeOff
kernel void rope(device float* q [[buffer(0)]], device float* kc [[buffer(1)]],
                 device const float* cosT [[buffer(2)]], device const float* sinT [[buffer(3)]],
                 constant RopeArgs& a [[buffer(4)]], uint p [[thread_position_in_grid]]) {
  const uint i = p * 2u;
  if (i >= a.d) return;
  const uint j = (i % a.hs) >> 1;
  const float fcr = cosT[a.ropeOff + j], fci = sinT[a.ropeOff + j];
  const float q0 = q[i], q1 = q[i + 1u];
  q[i] = q0 * fcr - q1 * fci;
  q[i + 1u] = q0 * fci + q1 * fcr;
  if (i < a.kvDim) {
    const float k0 = kc[a.kOff + i], k1 = kc[a.kOff + i + 1u];
    kc[a.kOff + i] = k0 * fcr - k1 * fci;
    kc[a.kOff + i + 1u] = k0 * fci + k1 * fcr;
  }
}

// one threadgroup of NT threads per head: the scores against the cache, softmax, the weighted values into xb
kernel void attention(device const float* q [[buffer(0)]], device const float* kc [[buffer(1)]],
                      device const float* vc [[buffer(2)]], device float* att [[buffer(3)]],
                      device float* xb [[buffer(4)]], constant AttnArgs& a [[buffer(5)]],
                      uint h [[threadgroup_position_in_grid]], uint tid [[thread_position_in_threadgroup]],
                      uint tiisg [[thread_index_in_simdgroup]], uint sgitg [[simdgroup_index_in_threadgroup]]) {
  threadgroup float part[NT / 32];
  const uint qOff = h * a.hs, attOff = h * a.ctx, kvHeadOff = (h / a.kvMul) * a.hs;
  const uint n = a.pos + 1u;
  float lmax = -INFINITY;
  for (uint t = tid; t < n; t += NT) {
    device const float* k = kc + a.loff + t * a.kvDim + kvHeadOff;
    float s = 0.0f;
    for (uint i = 0; i < a.hs; i++) s += q[qOff + i] * k[i];
    s *= a.scale;
    att[attOff + t] = s;
    lmax = max(lmax, s);
  }
  lmax = simd_max(lmax);
  if (tiisg == 0u) part[sgitg] = lmax;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  float m = part[0];
  for (uint i = 1; i < NT / 32; i++) m = max(m, part[i]);
  threadgroup_barrier(mem_flags::mem_threadgroup);
  float lsum = 0.0f;
  for (uint t = tid; t < n; t += NT) { const float e = exp(att[attOff + t] - m); att[attOff + t] = e; lsum += e; }
  lsum = simd_sum(lsum);
  if (tiisg == 0u) part[sgitg] = lsum;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  float sum = 0.0f;
  for (uint i = 0; i < NT / 32; i++) sum += part[i];
  const float inv = 1.0f / sum;
  if (tid < a.hs) {
    float acc = 0.0f;
    for (uint t = 0; t < n; t++) acc += att[attOff + t] * vc[a.loff + t * a.kvDim + kvHeadOff + tid];
    xb[qOff + tid] = acc * inv;
  }
}
`;

/** the arguments of a product: the weight's offset in the model, a second weight's (gate/up),
 *  rows, columns, flags (1 accumulate, 2 gate/up), the output offset in elements */
function mvArgs(w: Weight, base: number, flags: number, w2: Weight | null, outOff: number): Uint32Array {
  const a = new Uint32Array(6);
  a[0] = base + w.byteOff; a[1] = w2 === null ? a[0] : base + w2.byteOff; a[2] = w.rows; a[3] = w.cols; a[4] = flags; a[5] = outOff;
  return a;
}
function normArgs(n: number, eps: number, wOff: number): ArrayBuffer {
  const b = new ArrayBuffer(12);
  const u = new Uint32Array(b), f = new Float32Array(b);
  u[0] = n; f[1] = eps; u[2] = wOff;
  return b;
}
interface LayerPlan {
  attnNorm: ArrayBuffer; ffnNorm: ArrayBuffer;
  wq: Uint32Array; wk: Uint32Array; wv: Uint32Array; wo: Uint32Array; w13: Uint32Array; w2: Uint32Array;
  matvec: Pipeline; matvecDown: Pipeline;
  loff: number;
}

/** The Metal forward pass of a Llama (its buffers shared with the GPU, its kernels compiled once). */
export class LlamaMetal {
  readonly lm: Llama;
  readonly device: string;
  private readonly lib: Library;
  private readonly matvecs: Map<number, Pipeline> = new Map();
  private readonly rmsnorm: Pipeline;
  private readonly rope: Pipeline;
  private readonly attention: Pipeline;
  private readonly model: GpuBuffer;
  private readonly x: GpuBuffer; private readonly xb: GpuBuffer; private readonly q: GpuBuffer; private readonly hb: GpuBuffer;
  private readonly logits: GpuBuffer; private readonly att: GpuBuffer; private readonly kc: GpuBuffer; private readonly vc: GpuBuffer;
  private readonly norms: GpuBuffer; private readonly cosT: GpuBuffer; private readonly sinT: GpuBuffer;
  private readonly layers: LayerPlan[] = [];
  private readonly outNorm: ArrayBuffer;
  private readonly output: Uint32Array;
  private readonly outputMatvec: Pipeline;
  private readonly ropeArgs: Uint32Array;
  private readonly attnArgs: ArrayBuffer;
  private readonly attnU: Uint32Array;
  private readonly attnF: Float32Array;
  /** the kernels' time: the encode and the wait, per forward, for --stats */
  encodeMs = 0; waitMs = 0; forwards = 0;
  constructor(lm: Llama, options: { fastMath?: boolean } = {}) {
    if (lm.m.g.shared === null) throw new Error("garnet:llama_metal: the model must be in shared memory: readGguf(path, true)");
    if (!available()) throw new Error("garnet:llama_metal: Metal is not available");
    this.lm = lm;
    this.device = deviceName();
    this.ropeArgs = new Uint32Array(5);
    this.attnArgs = new ArrayBuffer(28);
    this.attnU = new Uint32Array(this.attnArgs);
    this.attnF = new Float32Array(this.attnArgs);
    this.lib = new Library(KERNEL_SOURCE, { fastMath: options.fastMath === true });
    this.matvecs.set(GGML_Q8_0, this.lib.pipeline("matvec_q8"));
    this.matvecs.set(GGML_Q4_0, this.lib.pipeline("matvec_q4"));
    this.matvecs.set(GGML_F32, this.lib.pipeline("matvec_f32"));
    this.matvecs.set(GGML_F16, this.lib.pipeline("matvec_f16"));
    this.rmsnorm = this.lib.pipeline("rmsnorm");
    this.rope = this.lib.pipeline("rope");
    this.attention = this.lib.pipeline("attention");
    const q8 = this.matvecs.get(GGML_Q8_0) as Pipeline;
    if (q8.threadExecutionWidth !== 32) throw new Error(`garnet:llama_metal: the kernels assume a SIMD width of 32 (the device has ${q8.threadExecutionWidth})`);
    if (this.rmsnorm.maxThreadsPerThreadgroup < NORM_THREADS || this.attention.maxThreadsPerThreadgroup < ATTN_THREADS) throw new Error("garnet:llama_metal: the device allows fewer threads per threadgroup than the kernels use");
    if (lm.headSize > ATTN_THREADS) throw new Error(`garnet:llama_metal: a head size of ${lm.headSize} exceeds the attention kernel's ${ATTN_THREADS} threads`);
    const sab = (v: Float32Array): SharedArrayBuffer => v.buffer as SharedArrayBuffer;
    this.model = new GpuBuffer(lm.m.g.shared);
    this.x = new GpuBuffer(sab(lm.x)); this.xb = new GpuBuffer(sab(lm.xb)); this.q = new GpuBuffer(sab(lm.q)); this.hb = new GpuBuffer(sab(lm.hb));
    this.logits = new GpuBuffer(sab(lm.logits)); this.att = new GpuBuffer(sab(lm.att));
    this.kc = new GpuBuffer(sab(lm.keyCache)); this.vc = new GpuBuffer(sab(lm.valueCache));
    // the norms end to end (attention and feed-forward per layer, then the output norm), the RoPE tables as floats
    const d = lm.nEmbd;
    const norms = new Float32Array(new SharedArrayBuffer((2 * lm.nLayer + 1) * d * 4));
    for (let l = 0; l < lm.nLayer; l++) { norms.set(lm.layers[l].attnNorm, (2 * l) * d); norms.set(lm.layers[l].ffnNorm, (2 * l + 1) * d); }
    norms.set(lm.outNorm, 2 * lm.nLayer * d);
    this.norms = new GpuBuffer(sab(norms));
    const cosT = new Float32Array(new SharedArrayBuffer(lm.ropeCos.length * 4)), sinT = new Float32Array(new SharedArrayBuffer(lm.ropeSin.length * 4));
    for (let i = 0; i < cosT.length; i++) { cosT[i] = lm.ropeCos[i]; sinT[i] = lm.ropeSin[i]; }
    this.cosT = new GpuBuffer(sab(cosT)); this.sinT = new GpuBuffer(sab(sinT));
    const base = lm.m.u8.byteOffset;
    const matvecOf = (w: Weight): Pipeline => {
      const p = this.matvecs.get(w.type);
      if (p === undefined) throw new Error(`garnet:llama_metal: no kernel for the quantization of ${w.name}`);
      return p;
    };
    for (let l = 0; l < lm.nLayer; l++) {
      const L = lm.layers[l];
      if (L.wq.type !== L.wk.type || L.wq.type !== L.wv.type || L.wq.type !== L.wo.type || L.w1.type !== L.w3.type) throw new Error("garnet:llama_metal: a layer mixes quantizations");
      const kvDim = lm.kvDim;
      this.layers.push({
        attnNorm: normArgs(d, lm.eps, (2 * l) * d), ffnNorm: normArgs(d, lm.eps, (2 * l + 1) * d),
        wq: mvArgs(L.wq, base, 0, null, 0), wk: mvArgs(L.wk, base, 0, null, 0), wv: mvArgs(L.wv, base, 0, null, 0),
        wo: mvArgs(L.wo, base, 1, null, 0), w13: mvArgs(L.w1, base, 2, L.w3, 0), w2: mvArgs(L.w2, base, 1, null, 0),
        matvec: matvecOf(L.wq), matvecDown: matvecOf(L.w2),
        loff: l * lm.ctx * kvDim,
      });
    }
    this.outNorm = normArgs(d, lm.eps, 2 * lm.nLayer * d);
    this.output = mvArgs(lm.output, base, 0, null, 0);
    this.outputMatvec = matvecOf(lm.output);
  }
  /** The logits of `token` at `pos`: one command buffer for the whole pass. */
  forward(token: number, pos: number): Float32Array {
    const lm = this.lm;
    const d = lm.nEmbd, kvDim = lm.kvDim, hs = lm.headSize;
    lm.m.row(lm.tokEmbd, token, lm.x);   // the embedding, by the CPU, into the shared x
    const t0 = performance.now();
    const cmd = new CommandBuffer();
    const ropeArgs = this.ropeArgs, attnU = this.attnU, attnF = this.attnF;
    ropeArgs[0] = d; ropeArgs[1] = kvDim; ropeArgs[2] = hs; ropeArgs[3] = pos * (hs >> 1);
    attnU[0] = pos; attnU[1] = hs; attnU[2] = kvDim; attnU[3] = lm.kvMul; attnU[4] = lm.ctx; attnF[6] = 1 / Math.sqrt(hs);
    const mvGroups = Math.ceil(d / MV_ROWS), kvGroups = Math.ceil(kvDim / MV_ROWS), ffGroups = Math.ceil(lm.nFf / MV_ROWS);
    const ropeGroups = Math.ceil((d >> 1) / NORM_THREADS);
    for (let l = 0; l < lm.nLayer; l++) {
      const L = this.layers[l];
      const kOff = L.loff + pos * kvDim;
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, this.x); cmd.buffer(1, this.norms); cmd.buffer(2, this.xb); cmd.bytes(3, L.attnNorm); cmd.dispatch(1, NORM_THREADS);
      cmd.pipeline(L.matvec); cmd.buffer(0, this.model); cmd.buffer(1, this.xb);
      cmd.buffer(2, this.q); cmd.bytes(3, L.wq); cmd.dispatch(mvGroups, MV_THREADS);
      L.wk[5] = kOff; cmd.buffer(2, this.kc); cmd.bytes(3, L.wk); cmd.dispatch(kvGroups, MV_THREADS);
      L.wv[5] = kOff; cmd.buffer(2, this.vc); cmd.bytes(3, L.wv); cmd.dispatch(kvGroups, MV_THREADS);
      ropeArgs[4] = kOff;
      cmd.pipeline(this.rope); cmd.buffer(0, this.q); cmd.buffer(1, this.kc); cmd.buffer(2, this.cosT); cmd.buffer(3, this.sinT); cmd.bytes(4, ropeArgs); cmd.dispatch(ropeGroups, NORM_THREADS);
      attnU[5] = L.loff;
      cmd.pipeline(this.attention); cmd.buffer(0, this.q); cmd.buffer(1, this.kc); cmd.buffer(2, this.vc); cmd.buffer(3, this.att); cmd.buffer(4, this.xb); cmd.bytes(5, this.attnArgs); cmd.dispatch(lm.nHead, ATTN_THREADS);
      cmd.pipeline(L.matvec); cmd.buffer(0, this.model); cmd.buffer(1, this.xb); cmd.buffer(2, this.x); cmd.bytes(3, L.wo); cmd.dispatch(mvGroups, MV_THREADS);
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, this.x); cmd.buffer(1, this.norms); cmd.buffer(2, this.xb); cmd.bytes(3, L.ffnNorm); cmd.dispatch(1, NORM_THREADS);
      cmd.pipeline(L.matvec); cmd.buffer(0, this.model); cmd.buffer(1, this.xb); cmd.buffer(2, this.hb); cmd.bytes(3, L.w13); cmd.dispatch(ffGroups, MV_THREADS);
      cmd.pipeline(L.matvecDown); cmd.buffer(0, this.model); cmd.buffer(1, this.hb); cmd.buffer(2, this.x); cmd.bytes(3, L.w2); cmd.dispatch(mvGroups, MV_THREADS);
    }
    cmd.pipeline(this.rmsnorm); cmd.buffer(0, this.x); cmd.buffer(1, this.norms); cmd.buffer(2, this.x); cmd.bytes(3, this.outNorm); cmd.dispatch(1, NORM_THREADS);
    cmd.pipeline(this.outputMatvec); cmd.buffer(0, this.model); cmd.buffer(1, this.x); cmd.buffer(2, this.logits); cmd.bytes(3, this.output); cmd.dispatch(Math.ceil(lm.vocab / MV_ROWS), MV_THREADS);
    cmd.commit();
    const t1 = performance.now();
    cmd.wait();
    this.encodeMs += t1 - t0; this.waitMs += performance.now() - t1; this.forwards++;
    return lm.logits;
  }
  /** Releases the GPU buffers (the Llama's memory stays). */
  release(): void {
    for (const b of [this.model, this.x, this.xb, this.q, this.hb, this.logits, this.att, this.kc, this.vc, this.norms, this.cosT, this.sinT]) b.release();
  }
}
