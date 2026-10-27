// garnet:metal (docs/metal_design.md): kernels compiled from source run over the program's
// SharedArrayBuffers in place. The values print the same whether the GPU computed them
// (garnet on macOS) or the CPU did (Node, or a build without Metal): on these inputs the
// kernels' float32 arithmetic is exact (the command buffer is concurrent: two independent
// dispatches, a barrier, then one that reads the first's result). The argument checks throw the same TypeError on
// both sides before any Metal call; the GPU-only failures (the compiler's log, a missing
// kernel, a released buffer, an oversized argument struct, a second open command buffer,
// commits and waits out of order) print only their kinds, which the CPU side prints as
// constants.
import { available, deviceName, Library, GpuBuffer, CommandBuffer } from "garnet:metal";

const SRC = `#include <metal_stdlib>
using namespace metal;
struct Axpb { uint n; float a; };
kernel void axpb(device const float* x [[buffer(0)]], device float* y [[buffer(1)]],
                 constant Axpb& p [[buffer(2)]], uint i [[thread_position_in_grid]]) {
  if (i < p.n) y[i] = x[i] * p.a + y[i];
}
kernel void row_sums(device const int* m [[buffer(0)]], device int* out [[buffer(1)]],
                     constant uint& cols [[buffer(2)]], uint r [[thread_position_in_grid]]) {
  int s = 0;
  for (uint j = 0; j < cols; j++) s += m[r * cols + j];
  out[r] = s;
}`;

function attempt(name: string, f: () => unknown): string {
  try { f(); return name + ":ok"; } catch (e) { return name + ":" + (e as Error).constructor.name; }
}
function joinInts(a: Int32Array): string {
  let s = "";
  for (let i = 0; i < a.length; i++) s += (i === 0 ? "" : ",") + a[i];
  return s;
}
function main(): void {
  const out: string[] = [];
  const n = 1000;
  const x = new Float32Array(new SharedArrayBuffer(n * 4));
  const ySab = new SharedArrayBuffer(256 + n * 4);   // y lives 256 bytes into its buffer (a buffer offset)
  const y = new Float32Array(ySab, 256, n);
  for (let i = 0; i < n; i++) { x[i] = i - 500; y[i] = (i % 7) * 0.5; }
  const m = new Int32Array(new SharedArrayBuffer(16 * 8 * 4)), sums = new Int32Array(new SharedArrayBuffer(16 * 4));
  for (let i = 0; i < m.length; i++) m[i] = (i * 37) % 101 - 50;
  const gpu = available();
  out.push("available:" + typeof gpu + " name:" + typeof deviceName());
  out.push(attempt("source-type", () => new Library(42 as unknown as string)));
  out.push(attempt("buffer-type", () => new GpuBuffer(new ArrayBuffer(16) as unknown as SharedArrayBuffer)));
  if (gpu) {
    const lib = new Library(SRC);
    const axpb = lib.pipeline("axpb"), rowSums = lib.pipeline("row_sums");
    out.push("limits:" + (axpb.maxThreadsPerThreadgroup >= 256) + "," + (axpb.threadExecutionWidth >= 4) + "," + axpb.name);
    const bx = new GpuBuffer(x.buffer as SharedArrayBuffer), by = new GpuBuffer(ySab);
    const bm = new GpuBuffer(m.buffer as SharedArrayBuffer), bs = new GpuBuffer(sums.buffer as SharedArrayBuffer);
    const args = new ArrayBuffer(8), args2 = new ArrayBuffer(8);
    new Uint32Array(args)[0] = n; new Uint32Array(args2)[0] = n;
    new Float32Array(args)[1] = 3; new Float32Array(args2)[1] = 2;
    const cols = new Uint32Array(1);
    cols[0] = 8;
    const empty = new CommandBuffer();   // opened and dropped: the next one may open
    out.push(attempt("second-open", () => new CommandBuffer()));
    empty.discard();
    const cmd = new CommandBuffer({ concurrent: true });
    cmd.pipeline(axpb); cmd.buffer(0, bx); cmd.buffer(1, by, 256); cmd.bytes(2, args); cmd.dispatch(Math.ceil(n / 256), 256);
    cmd.pipeline(rowSums); cmd.buffer(0, bm); cmd.buffer(1, bs); cmd.bytes(2, cols); cmd.dispatch3(1, 1, 1, 16, 1, 1);
    cmd.barrier();   // the second axpb reads the first's y
    cmd.pipeline(axpb); cmd.buffer(0, bx); cmd.buffer(1, by, 256); cmd.bytes(2, args2); cmd.dispatch(Math.ceil(n / 256), 256);
    out.push("concurrent:" + cmd.concurrent + "," + empty.concurrent);
    out.push(attempt("too-many-threads", () => cmd.dispatch(1, axpb.maxThreadsPerThreadgroup + 1)));
    out.push(attempt("no-threadgroups", () => cmd.dispatch(0, 32)));
    out.push(attempt("big-bytes", () => cmd.bytes(3, new Uint8Array(8192))));
    out.push(attempt("offset-past-end", () => cmd.buffer(4, bx, n * 4 + 4)));
    out.push(attempt("index-past-end", () => cmd.buffer(31, bx)));
    out.push(attempt("wait-before-commit", () => cmd.wait()));
    cmd.commit();
    out.push(attempt("commit-twice", () => cmd.commit()));
    cmd.wait();
    out.push(attempt("wait-twice", () => cmd.wait()));
    out.push(attempt("bad-source", () => new Library("kernel void f(device float* x) { x[0] = y; }")));
    out.push(attempt("no-kernel", () => lib.pipeline("missing")));
    bx.release();
    out.push(attempt("released", () => { const c = new CommandBuffer(); try { c.buffer(0, bx); } finally { c.discard(); } }));
    by.release(); bm.release(); bs.release();
  } else {
    for (let i = 0; i < n; i++) y[i] = x[i] * 3 + y[i];
    for (let r = 0; r < 16; r++) { let s = 0; for (let j = 0; j < 8; j++) s += m[r * 8 + j]; sums[r] = s; }
    for (let i = 0; i < n; i++) y[i] = x[i] * 2 + y[i];
    out.push("limits:true,true,axpb", "second-open:Error", "concurrent:true,false", "too-many-threads:RangeError", "no-threadgroups:RangeError",
             "big-bytes:RangeError", "offset-past-end:RangeError", "index-past-end:RangeError", "wait-before-commit:Error",
             "commit-twice:Error", "wait-twice:Error", "bad-source:Error", "no-kernel:Error", "released:Error");
  }
  out.push("y:" + y[0] + "," + y[1] + "," + y[499] + "," + y[500] + "," + y[999]);
  let h = 0;
  for (let i = 0; i < n; i++) h = (Math.imul(h, 31) + y[i] * 2) | 0;
  out.push("hash:" + h, "sums:" + joinInts(sums));
  console.log(out.join("\n"));
}
main();
