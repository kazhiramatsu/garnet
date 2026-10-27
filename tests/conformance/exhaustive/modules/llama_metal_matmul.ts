// garnet:llama_metal's batched product kernels (lib/garnet/llama_metal.ts, docs/llm_inference_design.md
// "Batched prefill") over synthetic weights whose values keep the half and float arithmetic exact: a
// Q8_0, a Q4_0, an F16 and an F32 weight in the GGUF block layouts, a row count and a token count
// that do not fill the kernels' 64 x 32 tiles, an output written at an offset with a stride, and a
// product accumulated onto another. The GPU computes them under garnet; TypeScript computes the same
// products under Node (or where Metal is absent); the printed values must agree byte for byte. The
// Metal 4 tensor kernels (where that library compiles: an M5 under macOS 26) run a second Q8_0 weight
// of small values, since their relaxed precision keeps only small integer sums exact: the three token
// tiles, an output at an offset with a stride, and the accumulating form.
import { available, Library, GpuBuffer, CommandBuffer } from "garnet:metal";
import { KERNEL_SOURCE, TENSOR_KERNEL_SOURCE, matmulArgs, MM_ROWS, MM_TOKENS, MM_THREADS, TM_ROWS, TM_TOKENS, TM_TOKENS_SMALL, TM_TOKENS_LARGE } from "garnet:llama_metal";

const ROWS = 70, COLS = 64, N = 37;   // 64 + 6 rows, 32 + 5 tokens, two blocks of 32 columns
const Q8_OFF = 0, Q8_ROW = (COLS >> 5) * 34;          // 68 bytes per row
const Q4_OFF = 4800, Q4_ROW = (COLS >> 5) * 18;       // 36 bytes per row
const F16_OFF = 7360, F16_ROW = COLS * 2;
const F32_OFF = 16352, F32_ROW = COLS * 4;
const S8_OFF = 34304;                                 // the small-valued Q8_0 weight of the tensor kernels
const MODEL_BYTES = 40960;
const OUT_OFF = 5, OUT_STRIDE = ROWS + 3;
const N2 = 70;                                        // the tensor kernels' tokens: two tiles of 64, three of 32, one of 128

/** the f16 bits of a value with at most ten fraction bits in [2^-14, 2^15) (exact) */
function f16(v: number): number {
  if (v === 0) return 0;
  const sign = v < 0 ? 0x8000 : 0;
  v = Math.abs(v);
  let e = 0;
  while (v >= 2) { v /= 2; e++; }
  while (v < 1) { v *= 2; e--; }
  return sign | ((e + 15) << 10) | Math.round((v - 1) * 1024);
}
function put16(u8: Uint8Array, off: number, bits: number): void { u8[off] = bits & 255; u8[off + 1] = bits >> 8; }

/** the four weights into the model bytes and, as plain numbers, into w[kind][row * COLS + k] */
function buildWeights(u8: Uint8Array, f32: Float32Array): number[][] {
  const w: number[][] = [[], [], [], [], []];
  for (let r = 0; r < ROWS; r++) {
    for (let b = 0; b < COLS >> 5; b++) {
      const d8 = (r + b) % 2 === 0 ? 0.5 : 2, p8 = Q8_OFF + r * Q8_ROW + b * 34;
      put16(u8, p8, f16(d8));
      for (let j = 0; j < 32; j++) { const q = ((r * 7 + b * 3 + j * 5) % 31) - 15; u8[p8 + 2 + j] = q & 255; w[0][r * COLS + b * 32 + j] = d8 * q; }
      const d4 = r % 3 === 0 ? 0.25 : 1, p4 = Q4_OFF + r * Q4_ROW + b * 18;
      put16(u8, p4, f16(d4));
      for (let j = 0; j < 16; j++) {
        const lo = (r + b + j) % 16, hi = (r * 3 + b + j * 5) % 16;
        u8[p4 + 2 + j] = lo | (hi << 4);
        w[1][r * COLS + b * 32 + j] = d4 * (lo - 8); w[1][r * COLS + b * 32 + 16 + j] = d4 * (hi - 8);
      }
    }
    for (let k = 0; k < COLS; k++) {
      const vh = ((r * 5 + k * 3) % 41) - 20, vf = ((r * 11 + k * 7) % 61) - 30;
      put16(u8, F16_OFF + r * F16_ROW + k * 2, f16(vh)); w[2][r * COLS + k] = vh;
      f32[(F32_OFF >> 2) + r * COLS + k] = vf; w[3][r * COLS + k] = vf;
    }
    for (let b = 0; b < COLS >> 5; b++) {   // scale 1, values -2 .. 2
      const p = S8_OFF + r * Q8_ROW + b * 34;
      put16(u8, p, f16(1));
      for (let j = 0; j < 32; j++) { const q = ((r * 3 + b + j * 7) % 5) - 2; u8[p + 2 + j] = q & 255; w[4][r * COLS + b * 32 + j] = q; }
    }
  }
  return w;
}
/** out[token * stride + off + row] (+)= W x for the reference, over `n` tokens */
function product(w: number[], x: Float32Array, out: Float32Array, off: number, stride: number, accumulate: boolean, n: number = N): void {
  for (let t = 0; t < n; t++) for (let r = 0; r < ROWS; r++) {
    let s = 0;
    for (let k = 0; k < COLS; k++) s += w[r * COLS + k] * x[t * COLS + k];
    if (accumulate) out[off + t * stride + r] += s; else out[off + t * stride + r] = s;
  }
}
function describe(name: string, out: Float32Array, off: number, stride: number, n: number = N): string {
  let h = 0;
  for (let t = 0; t < n; t++) for (let r = 0; r < ROWS; r++) h = (Math.imul(h, 31) + out[off + t * stride + r] * 4) | 0;
  return `${name}: ${out[off]} ${out[off + 1]} ${out[off + ROWS - 1]} ${out[off + (n - 1) * stride + 17]} ${out[off + (n - 1) * stride + ROWS - 1]} hash ${h}`;
}
/** The tensor kernels over the small weight: a plain product per token tile (the large tile holds the 70 tokens
 *  with room to spare), then the accumulating form at an offset with a stride; the reference where the library
 *  is absent. */
function tensorPart(modelSab: SharedArrayBuffer, w: number[], lines: string[]): void {
  const x2 = new Float32Array(new SharedArrayBuffer(N2 * COLS * 4));
  for (let i = 0; i < x2.length; i++) x2[i] = ((((i / COLS) | 0) * 5 + (i % COLS) * 3) % 3) - 1;   // -1, 0, 1
  const outA = new Float32Array(new SharedArrayBuffer(N2 * ROWS * 4));                 // the TM_TOKENS tile
  const outB = new Float32Array(new SharedArrayBuffer(N2 * ROWS * 4));                 // the TM_TOKENS_SMALL tile
  const outL = new Float32Array(new SharedArrayBuffer(N2 * ROWS * 4));                 // the TM_TOKENS_LARGE tile
  const outC = new Float32Array(new SharedArrayBuffer((OUT_OFF + N2 * OUT_STRIDE) * 4));   // twice the product, accumulated
  let lib: Library | null = null;
  if (available()) { try { lib = new Library(TENSOR_KERNEL_SOURCE, { languageVersion: "4.0" }); } catch (e) { lib = null; } }
  if (lib !== null) {
    const large = lib.pipeline(`matmul_q8_t${TM_TOKENS}`), small = lib.pipeline(`matmul_q8_t${TM_TOKENS_SMALL}`), largest = lib.pipeline(`matmul_q8_t${TM_TOKENS_LARGE}`);
    const model = new GpuBuffer(modelSab), bx = new GpuBuffer(x2.buffer as SharedArrayBuffer);
    const outs = [outA, outB, outC, outL].map((o) => new GpuBuffer(o.buffer as SharedArrayBuffer));
    const rowGroups = Math.ceil(ROWS / TM_ROWS);
    const cmd = new CommandBuffer();
    cmd.pipeline(large); cmd.buffer(0, model); cmd.buffer(1, bx); cmd.buffer(2, outs[0]);
    cmd.bytes(3, matmulArgs(S8_OFF, ROWS, COLS, Q8_ROW, N2, 0, COLS, 0, ROWS, 0)); cmd.dispatch3(Math.ceil(N2 / TM_TOKENS), rowGroups, 1, MM_THREADS, 1, 1);
    cmd.pipeline(small); cmd.buffer(0, model); cmd.buffer(1, bx); cmd.buffer(2, outs[1]);
    cmd.bytes(3, matmulArgs(S8_OFF, ROWS, COLS, Q8_ROW, N2, 0, COLS, 0, ROWS, 0)); cmd.dispatch3(Math.ceil(N2 / TM_TOKENS_SMALL), rowGroups, 1, MM_THREADS, 1, 1);
    cmd.pipeline(largest); cmd.buffer(0, model); cmd.buffer(1, bx); cmd.buffer(2, outs[3]);
    cmd.bytes(3, matmulArgs(S8_OFF, ROWS, COLS, Q8_ROW, N2, 0, COLS, 0, ROWS, 0)); cmd.dispatch3(Math.ceil(N2 / TM_TOKENS_LARGE), rowGroups, 1, MM_THREADS, 1, 1);
    for (let pass = 0; pass < 2; pass++) {
      cmd.pipeline(large); cmd.buffer(0, model); cmd.buffer(1, bx); cmd.buffer(2, outs[2]);
      cmd.bytes(3, matmulArgs(S8_OFF, ROWS, COLS, Q8_ROW, N2, 0, COLS, OUT_OFF, OUT_STRIDE, pass)); cmd.dispatch3(Math.ceil(N2 / TM_TOKENS), rowGroups, 1, MM_THREADS, 1, 1);
    }
    cmd.commit(); cmd.wait();
    model.release(); bx.release();
    for (const o of outs) o.release();
  } else {
    product(w, x2, outA, 0, ROWS, false, N2);
    product(w, x2, outB, 0, ROWS, false, N2);
    product(w, x2, outL, 0, ROWS, false, N2);
    product(w, x2, outC, OUT_OFF, OUT_STRIDE, false, N2);
    product(w, x2, outC, OUT_OFF, OUT_STRIDE, true, N2);
  }
  lines.push(describe("tensor", outA, 0, ROWS, N2), describe("tensor small tile", outB, 0, ROWS, N2), describe("tensor large tile", outL, 0, ROWS, N2), describe("tensor twice", outC, OUT_OFF, OUT_STRIDE, N2));
  lines.push("tensor untouched: " + outC[0] + " " + outC[OUT_OFF + ROWS] + " " + outC[OUT_OFF + ROWS + 2]);
}
function main(): void {
  const modelSab = new SharedArrayBuffer(MODEL_BYTES);
  const u8 = new Uint8Array(modelSab), f32 = new Float32Array(modelSab);
  const w = buildWeights(u8, f32);
  const x = new Float32Array(new SharedArrayBuffer(N * COLS * 4));
  for (let i = 0; i < x.length; i++) x[i] = ((((i / COLS) | 0) * 3 + (i % COLS)) % 11) - 5;
  const out0 = new Float32Array(new SharedArrayBuffer((OUT_OFF + N * OUT_STRIDE) * 4));   // the Q8_0 product at an offset with a stride
  const out1 = new Float32Array(new SharedArrayBuffer(N * ROWS * 4));                    // Q4_0
  const out2 = new Float32Array(new SharedArrayBuffer(N * ROWS * 4));                    // F16
  const out3 = new Float32Array(new SharedArrayBuffer(N * ROWS * 4));                    // F32, then the Q8_0 product added
  const lines: string[] = [];
  if (available()) {
    const lib = new Library(KERNEL_SOURCE);
    const kernels = [lib.pipeline("matmul_q8"), lib.pipeline("matmul_q4"), lib.pipeline("matmul_f16"), lib.pipeline("matmul_f32")];
    const model = new GpuBuffer(modelSab), bx = new GpuBuffer(x.buffer as SharedArrayBuffer);
    const outs = [out0, out1, out2, out3].map((o) => new GpuBuffer(o.buffer as SharedArrayBuffer));
    const offs = [Q8_OFF, Q4_OFF, F16_OFF, F32_OFF], rowBytes = [Q8_ROW, Q4_ROW, F16_ROW, F32_ROW];
    const cmd = new CommandBuffer();
    const groups = Math.ceil(N / MM_TOKENS), rowGroups = Math.ceil(ROWS / MM_ROWS);
    for (let kind = 0; kind < 4; kind++) {
      cmd.pipeline(kernels[kind]); cmd.buffer(0, model); cmd.buffer(1, bx); cmd.buffer(2, outs[kind]);
      cmd.bytes(3, matmulArgs(offs[kind], ROWS, COLS, rowBytes[kind], N, 0, COLS, kind === 0 ? OUT_OFF : 0, kind === 0 ? OUT_STRIDE : ROWS, 0));
      cmd.dispatch3(groups, rowGroups, 1, MM_THREADS, 1, 1);
    }
    cmd.pipeline(kernels[0]); cmd.buffer(0, model); cmd.buffer(1, bx); cmd.buffer(2, outs[3]);
    cmd.bytes(3, matmulArgs(Q8_OFF, ROWS, COLS, Q8_ROW, N, 0, COLS, 0, ROWS, 1));
    cmd.dispatch3(groups, rowGroups, 1, MM_THREADS, 1, 1);
    cmd.commit(); cmd.wait();
    lines.push("computed: gpu " + (kernels[0].threadExecutionWidth === 32));
    model.release(); bx.release();
    for (const o of outs) o.release();
  } else {
    product(w[0], x, out0, OUT_OFF, OUT_STRIDE, false);
    product(w[1], x, out1, 0, ROWS, false);
    product(w[2], x, out2, 0, ROWS, false);
    product(w[3], x, out3, 0, ROWS, false);
    product(w[0], x, out3, 0, ROWS, true);
    lines.push("computed: gpu true");
  }
  lines.push(describe("q8", out0, OUT_OFF, OUT_STRIDE), describe("q4", out1, 0, ROWS), describe("f16", out2, 0, ROWS), describe("f32+q8", out3, 0, ROWS));
  lines.push("untouched: " + out0[0] + " " + out0[OUT_OFF + ROWS] + " " + out0[OUT_OFF + ROWS + 2]);   // the stride's gaps and the offset's lead stay zero
  tensorPart(modelSab, w[4], lines);
  console.log(lines.join("\n"));
}
main();
