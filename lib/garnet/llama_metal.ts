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
// per block, a simd_sum at the end.
//
// The prompt runs as a batch (`forwardBatch`, "Batched prefill" in the design doc): the tokens'
// activations are rows of batch buffers, the norms, RoPE and the attention run per row, and each
// product is a matrix product over the weights dequantized to halves in threadgroup memory, so
// the 1.1 GB of weights is read once per tile of tokens instead of once per token. Two kernel
// families, both the shape of llama.cpp's mul_mm: on a device with the Metal 4 tensor API (the M5's
// neural accelerators; a second library compiled at language version 4.0, the simdgroup kernels
// when it does not compile) a threadgroup computes a tile of 64 weight rows by 32 or 64 tokens
// with `mpp::tensor_ops::matmul2d`, the activations read from device memory by the operation
// itself; otherwise a tile of 64 rows by 32 tokens with simdgroup matrices (half operands, float
// accumulators). The k and v rows land in the caches at their positions; the last token's logits
// come from the single-token kernels over its row. The command buffers are concurrent: q, k and
// v (and the gate and up pair) overlap, a barrier precedes each dependent group.
//
// The arithmetic is float32 in the GPU's order (half operands in the batched products), so the
// logits differ from the CPU path's in their low bits; `benchmarks/llama2/llama_gguf.ts
// --check-gpu` compares both paths with the CPU's over the prompt (the argmax per position, the
// last logits within a tolerance). Under Node, garnet:metal is absent and the constructor throws.
import { Library, Pipeline, GpuBuffer, CommandBuffer, available, deviceName } from "garnet:metal";
import { Llama, Weight, GGML_F32, GGML_F16, GGML_Q8_0, GGML_Q4_0 } from "./llama";
import { performance } from "node:perf_hooks";

const NSG = 4, NR = 2;                      // SIMD groups per threadgroup, rows per SIMD group
const MV_ROWS = NSG * NR, MV_THREADS = NSG * 32;
const NORM_THREADS = 256, ATTN_THREADS = 256;
/** the batched product's tile: MM_ROWS weight rows by MM_TOKENS tokens per threadgroup of MM_THREADS
 *  threads (four SIMD groups, each 32 rows by 16 tokens), MM_K columns per step (one quantized block) */
export const MM_ROWS = 64, MM_TOKENS = 32, MM_K = 32, MM_THREADS = 128;
/** the tensor kernels' tile: TM_ROWS weight rows by TM_TOKENS_SMALL (a batch of at most that many
 *  tokens) or TM_TOKENS tokens per threadgroup of MM_THREADS threads (four SIMD groups), TM_K columns
 *  per step; measured on the M5 over 8 to 200 tokens against tiles of 16 and 128 */
export const TM_ROWS = 64, TM_TOKENS_SMALL = 32, TM_TOKENS = 64, TM_K = 32;
/** the most tokens one batched forward pass runs (a longer prompt goes in chunks) */
export const BATCH_MAX = 128;

/** the part of the source both libraries share: the batched product's arguments and the weight rows */
const ROW_SOURCE = `struct MmArgs { uint off; uint rows; uint cols; uint rowBytes; uint n; uint bOff; uint bStride; uint outOff; uint outStride; uint flags; };
// 16 weights of a row from column k0 (a multiple of 16) as halves, by the quantization: 0 Q8_0, 1 Q4_0, 2 F16, 3 F32
template<short KIND> inline void mm_row16(device const char* row, uint k0, thread half* v) {
  if (KIND == 0) {
    device const char* blk = row + (k0 >> 5) * 34u;
    const float d = (float)(*(device const half*)blk);
    device const char* q = blk + 2u + (k0 & 16u);
    for (short i = 0; i < 16; i++) v[i] = (half)((float)q[i] * d);
  } else if (KIND == 1) {
    device const char* blk = row + (k0 >> 5) * 18u;
    const float d = (float)(*(device const half*)blk);
    device const uchar* q = (device const uchar*)(blk + 2u);
    const ushort sh = (k0 & 16u) ? 4 : 0;
    for (short i = 0; i < 16; i++) v[i] = (half)((float)((int)((q[i] >> sh) & 0xFu) - 8) * d);
  } else if (KIND == 2) {
    device const half* p = (device const half*)row + k0;
    for (short i = 0; i < 16; i++) v[i] = p[i];
  } else {
    device const float* p = (device const float*)row + k0;
    for (short i = 0; i < 16; i++) v[i] = (half)p[i];
  }
}`;

/** the tensor kernels' source: Metal 4 (language version "4.0"), compiled where the device has the
 *  tensor API; the batched product of a tile of TM_ROWS rows by TOK tokens by `matmul2d` over the
 *  weights dequantized to halves in threadgroup memory and the activations in device memory */
export const TENSOR_KERNEL_SOURCE = `#include <metal_stdlib>
#include <metal_tensor>
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
using namespace metal;
using namespace mpp::tensor_ops;
#define TM_ROWS ${TM_ROWS}
#define TM_K ${TM_K}
${ROW_SOURCE}
// out[token][row] (+)= sum over k of W[row][k] * x[token][k] for a tile of TM_ROWS rows by TOK tokens, the
// step's weights as halves [row][k] in threadgroup memory, the activation tile read by the operation
// from device memory, the accumulator a cooperative tensor loaded from out when flags has 1 (the
// shape of llama.cpp's tensor mul_mm)
template<short KIND, short TOK>
kernel void matmul_tensor_t(device const char* model [[buffer(0)]], device const float* x [[buffer(1)]],
                            device float* out [[buffer(2)]], constant MmArgs& a [[buffer(3)]],
                            uint3 tgpig [[threadgroup_position_in_grid]], ushort tiitg [[thread_index_in_threadgroup]]) {
  threadgroup half sa[TM_ROWS * TM_K];
  const int t0 = (int)tgpig.x * TOK, r0 = (int)tgpig.y * TM_ROWS;
  const int K = (int)a.cols, M = (int)a.rows, N = (int)a.n, strideB = (int)a.bStride;
  const int tileM = min((int)TM_ROWS, M - r0), tileN = min((int)TOK, N - t0);
  device float* ptrB = (device float*)(x + a.bOff);   // the tensor's element type must not be const
  auto tA = tensor(sa, dextents<int32_t, 2>(TM_K, TM_ROWS));
  auto tB = tensor(ptrB, dextents<int32_t, 2>(K, N), array<int, 2>({1, strideB}));
  // relaxed precision: measured 2.2x faster than the exact setting on the M5 (llama.cpp's choice too); the
  // logits stay within the check's tolerance
  matmul2d<matmul2d_descriptor(TOK, TM_ROWS, static_cast<int>(dynamic_extent), false, true, true, matmul2d_descriptor::mode::multiply_accumulate),
           execution_simdgroups<4>> mm;
  auto cT = mm.template get_destination_cooperative_tensor<decltype(tB), decltype(tA), float>();
  device float* dstTile = out + a.outOff + (uint)t0 * a.outStride + (uint)r0;
  auto tD = tensor(dstTile, dextents<int32_t, 2>(tileM, tileN), array<int, 2>({1, (int)a.outStride}));
  if (a.flags & 1u) cT.load(tD);
  else {
#pragma clang loop unroll(full)
    for (uint16_t i = 0; i < cT.get_capacity(); ++i) if (cT.is_valid_element(i)) cT[i] = 0.0f;
  }
  // this thread loads 16 weights of row (tiitg / 2), half (tiitg & 1) of the step; a row past the tile's
  // valid ones reads the last valid one (its results are outside the stored tile)
  const int row = tiitg >> 1, chunk = tiitg & 1;
  device const char* wrow = model + a.off + (uint)(r0 + min(row, tileM - 1)) * a.rowBytes;
  for (int k = 0; k < K; k += TM_K) {
    half va[16];
    mm_row16<KIND>(wrow, (uint)(k + chunk * 16), va);
    for (short i = 0; i < 16; i++) sa[row * TM_K + chunk * 16 + i] = va[i];
    threadgroup_barrier(mem_flags::mem_threadgroup);
    const int kExt = min((int)TM_K, K - k);
    auto tAv = tensor(sa, dextents<int32_t, 2>(kExt, TM_ROWS), array<int, 2>({1, TM_K}));
    auto tBv = tensor(ptrB + k + t0 * strideB, dextents<int32_t, 2>(kExt, N - t0), array<int, 2>({1, strideB}));
    mm.run(tBv, tAv, cT);
    threadgroup_barrier(mem_flags::mem_threadgroup);
  }
  cT.store(tD);
}
typedef decltype(matmul_tensor_t<0, ${TM_TOKENS}>) matmul_tensor_fn;
template [[host_name("matmul_q8_t${TM_TOKENS}")]] kernel matmul_tensor_fn matmul_tensor_t<0, ${TM_TOKENS}>;
template [[host_name("matmul_q4_t${TM_TOKENS}")]] kernel matmul_tensor_fn matmul_tensor_t<1, ${TM_TOKENS}>;
template [[host_name("matmul_f16_t${TM_TOKENS}")]] kernel matmul_tensor_fn matmul_tensor_t<2, ${TM_TOKENS}>;
template [[host_name("matmul_f32_t${TM_TOKENS}")]] kernel matmul_tensor_fn matmul_tensor_t<3, ${TM_TOKENS}>;
typedef decltype(matmul_tensor_t<0, ${TM_TOKENS_SMALL}>) matmul_tensor_small_fn;
template [[host_name("matmul_q8_t${TM_TOKENS_SMALL}")]] kernel matmul_tensor_small_fn matmul_tensor_t<0, ${TM_TOKENS_SMALL}>;
template [[host_name("matmul_q4_t${TM_TOKENS_SMALL}")]] kernel matmul_tensor_small_fn matmul_tensor_t<1, ${TM_TOKENS_SMALL}>;
template [[host_name("matmul_f16_t${TM_TOKENS_SMALL}")]] kernel matmul_tensor_small_fn matmul_tensor_t<2, ${TM_TOKENS_SMALL}>;
template [[host_name("matmul_f32_t${TM_TOKENS_SMALL}")]] kernel matmul_tensor_small_fn matmul_tensor_t<3, ${TM_TOKENS_SMALL}>;
`;

/** the kernels' source (exported for probes and tests) */
export const KERNEL_SOURCE = `#include <metal_stdlib>
using namespace metal;
#define NSG ${NSG}
#define NR ${NR}
#define NT ${NORM_THREADS}
#define MM_ROWS ${MM_ROWS}
#define MM_TOKENS ${MM_TOKENS}
#define MM_K ${MM_K}
struct MvArgs { uint off; uint off2; uint rows; uint cols; uint flags; uint outOff; };
struct NormArgs { uint n; float eps; uint wOff; };
struct RopeArgs { uint d; uint kvDim; uint hs; uint pos0; uint kOff; };
struct AttnArgs { uint pos0; uint hs; uint kvDim; uint kvMul; uint ctx; uint loff; float scale; uint d; uint nHead; };

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

${ROW_SOURCE}
// out[token][row] = sum over k of W[row][k] * x[token][k] for a tile of MM_ROWS rows by MM_TOKENS tokens:
// each step's weights dequantized to halves in threadgroup memory as 8x8 blocks [k][row], the
// activations as halves [token][k], and each SIMD group multiplies its 32 rows by 16 tokens with
// simdgroup matrices into float accumulators (the shape of llama.cpp's mul_mm); flags 1 adds to out
template<short KIND>
kernel void matmul_t(device const char* model [[buffer(0)]], device const float* x [[buffer(1)]],
                     device float* out [[buffer(2)]], constant MmArgs& a [[buffer(3)]],
                     uint3 tgpig [[threadgroup_position_in_grid]], ushort tiitg [[thread_index_in_threadgroup]],
                     ushort tiisg [[thread_index_in_simdgroup]], ushort sgitg [[simdgroup_index_in_threadgroup]]) {
  threadgroup float shmem[2048];                                   // the two operand tiles, then the result tile
  threadgroup half* sa = (threadgroup half*)shmem;                 // MM_ROWS x MM_K halves
  threadgroup half* sb = (threadgroup half*)(shmem + 1024);        // MM_TOKENS x MM_K halves
  const uint t0 = tgpig.x * MM_TOKENS, r0 = tgpig.y * MM_ROWS;
  const uint nTok = min((uint)MM_TOKENS, a.n - t0), nRow = min((uint)MM_ROWS, a.rows - r0);
  // this thread loads 16 weights of row (tiitg / 2), half (tiitg & 1) of the step, and 8 activations of
  // token (tiitg / 4), eighth (tiitg & 3) of the step; a row or token past the tile's valid ones reads
  // the last valid one (its results are never stored)
  const ushort ar = tiitg >> 1, ah = tiitg & 1, bt = tiitg >> 2, bk = tiitg & 3;
  device const char* wrow = model + a.off + (r0 + min((uint)ar, nRow - 1u)) * a.rowBytes;
  device const float* y = x + a.bOff + (t0 + min((uint)bt, nTok - 1u)) * a.bStride + bk * 8u;
  threadgroup half* sap = sa + 64 * (ar >> 3) + (ar & 7);          // block (8 * kBlock + rowBlock), column row & 7
  threadgroup half* sbp = sb + 64 * (4 * bk + (bt >> 3)) + 8 * (bt & 7);   // block (4 * kBlock + tokenBlock), row token & 7
  threadgroup const half* lsma = sa + 4 * 64 * (sgitg & 1);        // this SIMD group's 32 rows (4 row blocks)
  threadgroup const half* lsmb = sb + 2 * 64 * (sgitg >> 1);       // and 16 tokens (2 token blocks)
  simdgroup_half8x8 ma[4], mb[2];
  simdgroup_float8x8 mc[8];
  for (short i = 0; i < 8; i++) mc[i] = make_filled_simdgroup_matrix<float, 8>(0.0f);
  for (uint k = 0; k < a.cols; k += MM_K) {
    half va[16];
    mm_row16<KIND>(wrow, k + ah * 16u, va);
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (short i = 0; i < 16; i++) *(sap + 64 * 8 * (2 * ah + (i >> 3)) + 8 * (i & 7)) = va[i];
    *(threadgroup half2x4*)sbp = (half2x4)(*(device const float2x4*)(y + k));
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (short ik = 0; ik < MM_K / 8; ik++) {
      for (short i = 0; i < 4; i++) simdgroup_load(ma[i], lsma + 64 * (8 * ik + i), 8, 0, false);
      for (short i = 0; i < 2; i++) simdgroup_load(mb[i], lsmb + 64 * (4 * ik + i), 8, 0, false);
      for (short i = 0; i < 8; i++) simdgroup_multiply_accumulate(mc[i], mb[i >> 2], ma[i & 3], mc[i]);
    }
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);
  threadgroup float* sc = shmem + 32 * (sgitg & 1) + 16 * (sgitg >> 1) * MM_ROWS;   // the result tile [token][row]
  for (short i = 0; i < 8; i++) simdgroup_store(mc[i], sc + 8 * (i & 3) + 8 * MM_ROWS * (i >> 2), MM_ROWS, 0, false);
  threadgroup_barrier(mem_flags::mem_threadgroup);
  for (uint j = sgitg; j < nTok; j += 4) {
    device float* o = out + a.outOff + (t0 + j) * a.outStride + r0;
    for (uint r = tiisg; r < nRow; r += 32) { const float v = shmem[j * MM_ROWS + r]; if (a.flags & 1u) o[r] += v; else o[r] = v; }
  }
}
typedef decltype(matmul_t<0>) matmul_fn;
template [[host_name("matmul_q8")]] kernel matmul_fn matmul_t<0>;
template [[host_name("matmul_q4")]] kernel matmul_fn matmul_t<1>;
template [[host_name("matmul_f16")]] kernel matmul_fn matmul_t<2>;
template [[host_name("matmul_f32")]] kernel matmul_fn matmul_t<3>;

// reads one word of each page of a buffer (n pages): the GPU's first access maps the pages, which
// should not fall on the first token
kernel void touch(device const uint* p [[buffer(0)]], device uint* out [[buffer(1)]],
                  constant uint& n [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i < n && p[i * 1024u] == 0x7fc00001u) out[0] = i;
}

// g = silu(g) * u over n values (the gate and up products of a batch)
kernel void silu_mul(device float* g [[buffer(0)]], device const float* u [[buffer(1)]],
                     constant uint& n [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i < n) { const float v = g[i]; g[i] = v / (1.0f + exp(-v)) * u[i]; }
}

// out = w * (x / sqrt(mean(x^2) + eps)) for row (threadgroup) tg of n values, one threadgroup of NT threads (in place is fine)
kernel void rmsnorm(device const float* x [[buffer(0)]], device const float* w [[buffer(1)]],
                    device float* out [[buffer(2)]], constant NormArgs& a [[buffer(3)]],
                    uint tg [[threadgroup_position_in_grid]], uint tid [[thread_position_in_threadgroup]],
                    uint tiisg [[thread_index_in_simdgroup]], uint sgitg [[simdgroup_index_in_threadgroup]]) {
  threadgroup float part[NT / 32];
  x += tg * a.n; out += tg * a.n;
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

// RoPE over adjacent pairs of q and of the key at kOff, row (grid y) at position pos0 + row, the angles from the tables
kernel void rope(device float* q [[buffer(0)]], device float* kc [[buffer(1)]],
                 device const float* cosT [[buffer(2)]], device const float* sinT [[buffer(3)]],
                 constant RopeArgs& a [[buffer(4)]], uint2 p [[thread_position_in_grid]]) {
  const uint i = p.x * 2u, row = p.y;
  if (i >= a.d) return;
  const uint j = (i % a.hs) >> 1, ropeOff = (a.pos0 + row) * (a.hs >> 1);
  const float fcr = cosT[ropeOff + j], fci = sinT[ropeOff + j];
  device float* qr = q + row * a.d;
  const float q0 = qr[i], q1 = qr[i + 1u];
  qr[i] = q0 * fcr - q1 * fci;
  qr[i + 1u] = q0 * fci + q1 * fcr;
  if (i < a.kvDim) {
    device float* kr = kc + a.kOff + row * a.kvDim;
    const float k0 = kr[i], k1 = kr[i + 1u];
    kr[i] = k0 * fcr - k1 * fci;
    kr[i + 1u] = k0 * fci + k1 * fcr;
  }
}

// one threadgroup of NT threads per (head, row): the scores against the cache up to the row's position,
// softmax, the weighted values into the row of xb; att holds a row's scores per head
kernel void attention(device const float* q [[buffer(0)]], device const float* kc [[buffer(1)]],
                      device const float* vc [[buffer(2)]], device float* att [[buffer(3)]],
                      device float* xb [[buffer(4)]], constant AttnArgs& a [[buffer(5)]],
                      uint2 tg [[threadgroup_position_in_grid]], uint tid [[thread_index_in_threadgroup]],
                      uint tiisg [[thread_index_in_simdgroup]], uint sgitg [[simdgroup_index_in_threadgroup]]) {
  threadgroup float part[NT / 32];
  const uint h = tg.x, row = tg.y;
  const uint qOff = row * a.d + h * a.hs, attOff = (row * a.nHead + h) * a.ctx, kvHeadOff = (h / a.kvMul) * a.hs;
  const uint n = a.pos0 + row + 1u;
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
/** the arguments of a batched product: the weight (its offset in the model, rows, columns, bytes per
 *  row), the token count, the activation rows (offset and stride in floats), the output rows (offset
 *  and stride in floats), flags (1 adds to the output) */
export function matmulArgs(off: number, rows: number, cols: number, rowBytes: number, n: number, bOff: number, bStride: number, outOff: number, outStride: number, flags: number): Uint32Array {
  const a = new Uint32Array(10);
  a[0] = off; a[1] = rows; a[2] = cols; a[3] = rowBytes; a[4] = n; a[5] = bOff; a[6] = bStride; a[7] = outOff; a[8] = outStride; a[9] = flags;
  return a;
}
/** the fields of matmulArgs a forward pass sets per batch */
const MM_N = 4, MM_OUTOFF = 7;
/** the bytes of one row of a weight in its quantization's layout */
export function weightRowBytes(w: Weight): number {
  return w.type === GGML_Q8_0 ? (w.cols >> 5) * 34 : w.type === GGML_Q4_0 ? (w.cols >> 5) * 18 : w.type === GGML_F16 ? w.cols * 2 : w.cols * 4;
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
  /** the batched products: q, k, v, the output, gate, up, down */
  mq: Uint32Array; mk: Uint32Array; mv: Uint32Array; mo: Uint32Array; m1: Uint32Array; m3: Uint32Array; m2: Uint32Array;
  loff: number;
}
/** the batch buffers: `cap` rows of the residual, the normed activation, q, the gate and up products,
 *  a row's attention scores per head, and (for the check) every row's logits */
interface Batch {
  cap: number;
  x: GpuBuffer; xv: Float32Array;
  xb: GpuBuffer; q: GpuBuffer; hb: GpuBuffer; hb2: GpuBuffer; att: GpuBuffer;
  logits: GpuBuffer | null; logitsV: Float32Array;
}

/** The Metal forward pass of a Llama (its buffers shared with the GPU, its kernels compiled once). */
export class LlamaMetal {
  readonly lm: Llama;
  readonly device: string;
  /** whether the batched prompt path applies (every product's columns a multiple of 32) */
  readonly batched: boolean;
  /** whether the batched products run on the Metal 4 tensor API (the library compiled and the device ran it) */
  readonly tensor: boolean;
  private readonly lib: Library;
  private readonly matvecs: Map<number, Pipeline> = new Map();
  private readonly matmuls: Map<number, Pipeline> = new Map();
  private readonly tensorMatmuls: Map<number, Pipeline> = new Map();        // the TM_TOKENS tile
  private readonly tensorMatmulsSmall: Map<number, Pipeline> = new Map();   // the TM_TOKENS_SMALL tile
  private readonly rmsnorm: Pipeline;
  private readonly rope: Pipeline;
  private readonly attention: Pipeline;
  private readonly siluMul: Pipeline;
  private readonly model: GpuBuffer;
  private readonly x: GpuBuffer; private readonly xb: GpuBuffer; private readonly q: GpuBuffer; private readonly hb: GpuBuffer;
  private readonly logits: GpuBuffer; private readonly att: GpuBuffer; private readonly kc: GpuBuffer; private readonly vc: GpuBuffer;
  private readonly norms: GpuBuffer; private readonly cosT: GpuBuffer; private readonly sinT: GpuBuffer;
  private readonly layers: LayerPlan[] = [];
  private readonly outNorm: ArrayBuffer;
  private readonly output: Uint32Array;
  private readonly outputMatvec: Pipeline;
  private readonly mOut: Uint32Array;
  private readonly touchOut: GpuBuffer;
  private readonly ropeArgs: Uint32Array;
  private readonly attnArgs: ArrayBuffer;
  private readonly attnU: Uint32Array;
  private readonly attnF: Float32Array;
  private readonly siluN: Uint32Array;
  private batch: Batch | null = null;
  /** the kernels' time: the encode and the wait, per single-token forward and per batch, for --stats */
  encodeMs = 0; waitMs = 0; forwards = 0;
  batchEncodeMs = 0; batchWaitMs = 0; batches = 0; batchTokens = 0;
  /** `tensor: false` keeps the batched products on the simdgroup kernels where the tensor API exists */
  constructor(lm: Llama, options: { fastMath?: boolean; tensor?: boolean } = {}) {
    if (lm.m.g.shared === null) throw new Error("garnet:llama_metal: the model must be in shared memory: readGguf(path, true)");
    if (!available()) throw new Error("garnet:llama_metal: Metal is not available");
    this.lm = lm;
    this.device = deviceName();
    this.ropeArgs = new Uint32Array(5);
    this.attnArgs = new ArrayBuffer(36);
    this.attnU = new Uint32Array(this.attnArgs);
    this.attnF = new Float32Array(this.attnArgs);
    this.siluN = new Uint32Array(1);
    const fastMath = options.fastMath === true;
    this.lib = new Library(KERNEL_SOURCE, { fastMath });
    const kinds = [GGML_Q8_0, GGML_Q4_0, GGML_F16, GGML_F32], names = ["q8", "q4", "f16", "f32"];
    for (let i = 0; i < kinds.length; i++) {
      this.matvecs.set(kinds[i], this.lib.pipeline("matvec_" + names[i]));
      this.matmuls.set(kinds[i], this.lib.pipeline("matmul_" + names[i]));
    }
    // the tensor API's library: a device or an OS without it fails the compile (an Error), and the
    // simdgroup kernels stay
    let tensor = false;
    if (options.tensor !== false) {
      try {
        const tlib = new Library(TENSOR_KERNEL_SOURCE, { fastMath, languageVersion: "4.0" });
        for (let i = 0; i < kinds.length; i++) {
          this.tensorMatmuls.set(kinds[i], tlib.pipeline(`matmul_${names[i]}_t${TM_TOKENS}`));
          this.tensorMatmulsSmall.set(kinds[i], tlib.pipeline(`matmul_${names[i]}_t${TM_TOKENS_SMALL}`));
        }
        tensor = true;
      } catch (e) {
        this.tensorMatmuls.clear(); this.tensorMatmulsSmall.clear();
        tensor = false;
      }
    }
    this.tensor = tensor;
    this.rmsnorm = this.lib.pipeline("rmsnorm");
    this.rope = this.lib.pipeline("rope");
    this.attention = this.lib.pipeline("attention");
    this.siluMul = this.lib.pipeline("silu_mul");
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
    const d = lm.nEmbd, kvDim = lm.kvDim, ff = lm.nFf;
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
    // a batched product: the weight's rows against `bStride`-wide activation rows into `outStride`-wide output rows
    const mm = (w: Weight, outStride: number, flags: number): Uint32Array => matmulArgs(base + w.byteOff, w.rows, w.cols, weightRowBytes(w), 0, 0, w.cols, 0, outStride, flags);
    let batched = lm.output.cols % 32 === 0;
    for (let l = 0; l < lm.nLayer; l++) {
      const L = lm.layers[l];
      if (L.wq.type !== L.wk.type || L.wq.type !== L.wv.type || L.wq.type !== L.wo.type || L.w1.type !== L.w3.type) throw new Error("garnet:llama_metal: a layer mixes quantizations");
      if (L.wq.cols % 32 !== 0 || L.w2.cols % 32 !== 0) batched = false;
      this.layers.push({
        attnNorm: normArgs(d, lm.eps, (2 * l) * d), ffnNorm: normArgs(d, lm.eps, (2 * l + 1) * d),
        wq: mvArgs(L.wq, base, 0, null, 0), wk: mvArgs(L.wk, base, 0, null, 0), wv: mvArgs(L.wv, base, 0, null, 0),
        wo: mvArgs(L.wo, base, 1, null, 0), w13: mvArgs(L.w1, base, 2, L.w3, 0), w2: mvArgs(L.w2, base, 1, null, 0),
        matvec: matvecOf(L.wq), matvecDown: matvecOf(L.w2),
        mq: mm(L.wq, d, 0), mk: mm(L.wk, kvDim, 0), mv: mm(L.wv, kvDim, 0), mo: mm(L.wo, d, 1), m1: mm(L.w1, ff, 0), m3: mm(L.w3, ff, 0), m2: mm(L.w2, d, 1),
        loff: l * lm.ctx * kvDim,
      });
    }
    this.batched = batched;
    this.outNorm = normArgs(d, lm.eps, 2 * lm.nLayer * d);
    this.output = mvArgs(lm.output, base, 0, null, 0);
    this.outputMatvec = matvecOf(lm.output);
    this.mOut = mm(lm.output, lm.vocab, 0);
    this.attnU[1] = lm.headSize; this.attnU[2] = kvDim; this.attnU[3] = lm.kvMul; this.attnU[4] = lm.ctx; this.attnF[6] = 1 / Math.sqrt(lm.headSize);
    this.attnU[7] = d; this.attnU[8] = lm.nHead;
    this.ropeArgs[0] = d; this.ropeArgs[1] = kvDim; this.ropeArgs[2] = lm.headSize;
    // the GPU's first access to a page maps it (the model's 1.1 GB at half the streaming rate): the
    // model and the caches are touched now, not on the first token
    this.touchOut = new GpuBuffer(new SharedArrayBuffer(4096));
    const touch = this.lib.pipeline("touch"), pages = new Uint32Array(1);
    const cmd = new CommandBuffer();
    for (const g of [this.model, this.kc, this.vc]) {
      pages[0] = Math.ceil(g.byteLength / 4096);
      cmd.pipeline(touch); cmd.buffer(0, g); cmd.buffer(1, this.touchOut); cmd.bytes(2, pages); cmd.dispatch(Math.ceil(pages[0] / NORM_THREADS), NORM_THREADS);
    }
    cmd.commit(); cmd.wait();
  }
  /** One batched product of `n` tokens: the tensor kernel of the token tile that fits when the device has it,
   *  else the simdgroup kernel; `b` holds the activation rows, `out` receives the rows `args` names. */
  private product(cmd: CommandBuffer, w: Weight, args: Uint32Array, n: number, b: GpuBuffer, out: GpuBuffer): void {
    args[MM_N] = n;
    let p: Pipeline, tokGroups: number;
    if (this.tensor) {
      const small = n <= TM_TOKENS_SMALL;
      p = (small ? this.tensorMatmulsSmall : this.tensorMatmuls).get(w.type) as Pipeline;
      tokGroups = Math.ceil(n / (small ? TM_TOKENS_SMALL : TM_TOKENS));
    } else {
      p = this.matmuls.get(w.type) as Pipeline;
      tokGroups = Math.ceil(n / MM_TOKENS);
    }
    cmd.pipeline(p); cmd.buffer(0, this.model); cmd.buffer(1, b); cmd.buffer(2, out); cmd.bytes(3, args);
    cmd.dispatch3(tokGroups, Math.ceil(w.rows / MM_ROWS), 1, MM_THREADS, 1, 1);
  }
  /** The logits of `token` at `pos`: one command buffer for the whole pass. */
  forward(token: number, pos: number): Float32Array {
    const lm = this.lm;
    const d = lm.nEmbd, kvDim = lm.kvDim;
    lm.m.row(lm.tokEmbd, token, lm.x);   // the embedding, by the CPU, into the shared x
    const t0 = performance.now();
    const cmd = new CommandBuffer({ concurrent: true });   // q, k and v (and the gate and up pair) overlap; a barrier before each dependent group
    const ropeArgs = this.ropeArgs, attnU = this.attnU;
    ropeArgs[3] = pos;
    attnU[0] = pos;
    const mvGroups = Math.ceil(d / MV_ROWS), kvGroups = Math.ceil(kvDim / MV_ROWS), ffGroups = Math.ceil(lm.nFf / MV_ROWS);
    const ropeGroups = Math.ceil((d >> 1) / NORM_THREADS);
    for (let l = 0; l < lm.nLayer; l++) {
      const L = this.layers[l];
      const kOff = L.loff + pos * kvDim;
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, this.x); cmd.buffer(1, this.norms); cmd.buffer(2, this.xb); cmd.bytes(3, L.attnNorm); cmd.dispatch(1, NORM_THREADS);
      cmd.barrier();
      cmd.pipeline(L.matvec); cmd.buffer(0, this.model); cmd.buffer(1, this.xb);
      cmd.buffer(2, this.q); cmd.bytes(3, L.wq); cmd.dispatch(mvGroups, MV_THREADS);
      L.wk[5] = kOff; cmd.buffer(2, this.kc); cmd.bytes(3, L.wk); cmd.dispatch(kvGroups, MV_THREADS);
      L.wv[5] = kOff; cmd.buffer(2, this.vc); cmd.bytes(3, L.wv); cmd.dispatch(kvGroups, MV_THREADS);
      cmd.barrier();
      ropeArgs[4] = kOff;
      cmd.pipeline(this.rope); cmd.buffer(0, this.q); cmd.buffer(1, this.kc); cmd.buffer(2, this.cosT); cmd.buffer(3, this.sinT); cmd.bytes(4, ropeArgs); cmd.dispatch(ropeGroups, NORM_THREADS);
      cmd.barrier();
      attnU[5] = L.loff;
      cmd.pipeline(this.attention); cmd.buffer(0, this.q); cmd.buffer(1, this.kc); cmd.buffer(2, this.vc); cmd.buffer(3, this.att); cmd.buffer(4, this.xb); cmd.bytes(5, this.attnArgs); cmd.dispatch(lm.nHead, ATTN_THREADS);
      cmd.barrier();
      cmd.pipeline(L.matvec); cmd.buffer(0, this.model); cmd.buffer(1, this.xb); cmd.buffer(2, this.x); cmd.bytes(3, L.wo); cmd.dispatch(mvGroups, MV_THREADS);
      cmd.barrier();
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, this.x); cmd.buffer(1, this.norms); cmd.buffer(2, this.xb); cmd.bytes(3, L.ffnNorm); cmd.dispatch(1, NORM_THREADS);
      cmd.barrier();
      cmd.pipeline(L.matvec); cmd.buffer(0, this.model); cmd.buffer(1, this.xb); cmd.buffer(2, this.hb); cmd.bytes(3, L.w13); cmd.dispatch(ffGroups, MV_THREADS);
      cmd.barrier();
      cmd.pipeline(L.matvecDown); cmd.buffer(0, this.model); cmd.buffer(1, this.hb); cmd.buffer(2, this.x); cmd.bytes(3, L.w2); cmd.dispatch(mvGroups, MV_THREADS);
      cmd.barrier();
    }
    cmd.pipeline(this.rmsnorm); cmd.buffer(0, this.x); cmd.buffer(1, this.norms); cmd.buffer(2, this.x); cmd.bytes(3, this.outNorm); cmd.dispatch(1, NORM_THREADS);
    cmd.barrier();
    cmd.pipeline(this.outputMatvec); cmd.buffer(0, this.model); cmd.buffer(1, this.x); cmd.buffer(2, this.logits); cmd.bytes(3, this.output); cmd.dispatch(Math.ceil(lm.vocab / MV_ROWS), MV_THREADS);
    cmd.commit();
    const t1 = performance.now();
    cmd.wait();
    this.encodeMs += t1 - t0; this.waitMs += performance.now() - t1; this.forwards++;
    return lm.logits;
  }
  /** The logits of the last of `tokens`, placed at pos0, pos0 + 1, ...: the tokens as one batch (in
   *  chunks of BATCH_MAX), one token at a time when the model has no batched path. */
  forwardBatch(tokens: number[], pos0: number): Float32Array {
    const n = tokens.length;
    if (n === 0) throw new RangeError("garnet:llama_metal: forwardBatch needs at least one token");
    if (!this.batched) {
      let lg = this.lm.logits;
      for (let i = 0; i < n; i++) lg = this.forward(tokens[i], pos0 + i);
      return lg;
    }
    for (let c = 0; c < n; c += BATCH_MAX) this.runBatch(tokens, c, Math.min(n - c, BATCH_MAX), pos0 + c, false);
    return this.lm.logits;
  }
  /** Every token's logits, `tokens.length` rows of `vocab` floats (at most BATCH_MAX tokens): the
   *  check of the batched path against the CPU's per position. */
  forwardBatchAll(tokens: number[], pos0: number): Float32Array {
    const n = tokens.length;
    if (n === 0 || n > BATCH_MAX) throw new RangeError(`garnet:llama_metal: forwardBatchAll takes 1 to ${BATCH_MAX} tokens`);
    if (!this.batched) throw new Error("garnet:llama_metal: the model has no batched path (a product's columns are not a multiple of 32)");
    const b = this.runBatch(tokens, 0, n, pos0, true);
    return b.logitsV.subarray(0, n * this.lm.vocab);
  }
  /** The batch buffers for `n` rows (grown as needed; the logits rows only for the check). */
  private ensureBatch(n: number, all: boolean): Batch {
    const lm = this.lm, d = lm.nEmbd;
    const mk = (len: number): GpuBuffer => new GpuBuffer(new SharedArrayBuffer(len * 4));
    let b = this.batch;
    if (b === null || b.cap < n) {
      if (b !== null) { for (const g of [b.x, b.xb, b.q, b.hb, b.hb2, b.att]) g.release(); if (b.logits !== null) b.logits.release(); }
      const cap = Math.min(BATCH_MAX, Math.ceil(n / MM_TOKENS) * MM_TOKENS);
      const x = mk(cap * d);
      b = { cap, x, xv: new Float32Array(x.storage), xb: mk(cap * d), q: mk(cap * d), hb: mk(cap * lm.nFf), hb2: mk(cap * lm.nFf), att: mk(cap * lm.nHead * lm.ctx), logits: null, logitsV: new Float32Array(0) };
      this.batch = b;
    }
    if (all && b.logits === null) { const g = mk(b.cap * lm.vocab); b.logits = g; b.logitsV = new Float32Array(g.storage); }
    return b;
  }
  /** `n` tokens from `from` at positions pos0 ..: one command buffer; the last token's logits into the
   *  Llama's logits, or every token's into the batch's when `all`. */
  private runBatch(tokens: number[], from: number, n: number, pos0: number, all: boolean): Batch {
    const lm = this.lm;
    const d = lm.nEmbd, kvDim = lm.kvDim, ff = lm.nFf;
    const b = this.ensureBatch(n, all);
    for (let i = 0; i < n; i++) lm.m.row(lm.tokEmbd, tokens[from + i], b.xv.subarray(i * d, (i + 1) * d));   // the embeddings, by the CPU
    const t0 = performance.now();
    const cmd = new CommandBuffer({ concurrent: true });   // q, k and v, then gate and up, overlap; a barrier before each dependent group
    const ropeArgs = this.ropeArgs, attnU = this.attnU, siluN = this.siluN;
    ropeArgs[3] = pos0;
    attnU[0] = pos0;
    siluN[0] = n * ff;
    const ropeGroups = Math.ceil((d >> 1) / NORM_THREADS), siluGroups = Math.ceil((n * ff) / NORM_THREADS);
    for (let l = 0; l < lm.nLayer; l++) {
      const L = this.layers[l], W = lm.layers[l];
      const kOff = L.loff + pos0 * kvDim;
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, b.x); cmd.buffer(1, this.norms); cmd.buffer(2, b.xb); cmd.bytes(3, L.attnNorm); cmd.dispatch(n, NORM_THREADS);
      cmd.barrier();
      this.product(cmd, W.wq, L.mq, n, b.xb, b.q);
      L.mk[MM_OUTOFF] = kOff; this.product(cmd, W.wk, L.mk, n, b.xb, this.kc);
      L.mv[MM_OUTOFF] = kOff; this.product(cmd, W.wv, L.mv, n, b.xb, this.vc);
      cmd.barrier();
      ropeArgs[4] = kOff;
      cmd.pipeline(this.rope); cmd.buffer(0, b.q); cmd.buffer(1, this.kc); cmd.buffer(2, this.cosT); cmd.buffer(3, this.sinT); cmd.bytes(4, ropeArgs); cmd.dispatch3(ropeGroups, n, 1, NORM_THREADS, 1, 1);
      cmd.barrier();
      attnU[5] = L.loff;
      cmd.pipeline(this.attention); cmd.buffer(0, b.q); cmd.buffer(1, this.kc); cmd.buffer(2, this.vc); cmd.buffer(3, b.att); cmd.buffer(4, b.xb); cmd.bytes(5, this.attnArgs); cmd.dispatch3(lm.nHead, n, 1, ATTN_THREADS, 1, 1);
      cmd.barrier();
      this.product(cmd, W.wo, L.mo, n, b.xb, b.x);
      cmd.barrier();
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, b.x); cmd.buffer(1, this.norms); cmd.buffer(2, b.xb); cmd.bytes(3, L.ffnNorm); cmd.dispatch(n, NORM_THREADS);
      cmd.barrier();
      this.product(cmd, W.w1, L.m1, n, b.xb, b.hb);
      this.product(cmd, W.w3, L.m3, n, b.xb, b.hb2);
      cmd.barrier();
      cmd.pipeline(this.siluMul); cmd.buffer(0, b.hb); cmd.buffer(1, b.hb2); cmd.bytes(2, siluN); cmd.dispatch(siluGroups, NORM_THREADS);
      cmd.barrier();
      this.product(cmd, W.w2, L.m2, n, b.hb, b.x);
      cmd.barrier();
    }
    if (all) {
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, b.x); cmd.buffer(1, this.norms); cmd.buffer(2, b.xb); cmd.bytes(3, this.outNorm); cmd.dispatch(n, NORM_THREADS);
      cmd.barrier();
      this.product(cmd, lm.output, this.mOut, n, b.xb, b.logits as GpuBuffer);
    } else {
      // the last row only: its norm into the single-token x, the vocabulary product as for one token
      cmd.pipeline(this.rmsnorm); cmd.buffer(0, b.x, (n - 1) * d * 4); cmd.buffer(1, this.norms); cmd.buffer(2, this.x); cmd.bytes(3, this.outNorm); cmd.dispatch(1, NORM_THREADS);
      cmd.barrier();
      cmd.pipeline(this.outputMatvec); cmd.buffer(0, this.model); cmd.buffer(1, this.x); cmd.buffer(2, this.logits); cmd.bytes(3, this.output); cmd.dispatch(Math.ceil(lm.vocab / MV_ROWS), MV_THREADS);
    }
    cmd.commit();
    const t1 = performance.now();
    cmd.wait();
    this.batchEncodeMs += t1 - t0; this.batchWaitMs += performance.now() - t1; this.batches++; this.batchTokens += n;
    return b;
  }
  /** Releases the GPU buffers (the Llama's memory stays). */
  release(): void {
    for (const b of [this.model, this.x, this.xb, this.q, this.hb, this.logits, this.att, this.kc, this.vc, this.norms, this.cosT, this.sinT, this.touchOut]) b.release();
    const b = this.batch;
    if (b !== null) { for (const g of [b.x, b.xb, b.q, b.hb, b.hb2, b.att]) g.release(); if (b.logits !== null) b.logits.release(); this.batch = null; }
  }
}
