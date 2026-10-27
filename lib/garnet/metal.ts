// garnet:metal — Metal compute from TypeScript (docs/metal_design.md).
//
// The GPU on macOS through the runtime's `__garnet_metal` host. A Library compiles Metal
// Shading Language source at run time (the compiler's log is the Error's message; fast math
// is off unless asked for, so a kernel's arithmetic is the text's, not reassociated behind
// the program's back); its pipelines are the kernels by name. A GpuBuffer is a
// SharedArrayBuffer the GPU reads and writes in place (unified memory, no copy in either
// direction: the program's typed arrays over the same buffer hold the results once wait()
// returns). A CommandBuffer encodes any number of dispatches, serial (each sees the previous
// one's writes) or concurrent (independent dispatches may overlap; barrier() orders the
// dependent ones), for one commit and one wait; pipeline, buffer, bytes and dispatch mirror
// the compute encoder, so a pass of hundreds of kernels is a loop of host calls with no
// allocation per dispatch. Wrong argument types are TypeErrors before any Metal call;
// out-of-range arguments (an argument struct over 4 KB, a buffer index past 30, an offset
// past the buffer, zero threadgroups, more threads than the pipeline allows) are
// RangeErrors; a compile failure, a missing kernel, a released buffer, a failed command
// buffer and a use where Metal is not available are Errors. available() is false without
// Metal (Linux); under Node the same module name resolves to metal_node.ts
// (scripts/garnet_scheme_loader.mjs), where it is false too and the classes throw after
// the same argument checks.

declare global {
  var __garnet_metal: {
    available(): boolean;
    deviceName(): string;
    compile(source: string, fastMath: boolean, languageVersion: string | undefined): number;
    pipeline(library: number, name: string): number;
    pipelineMaxThreads(pipeline: number): number;
    pipelineSimdWidth(pipeline: number): number;
    buffer(storage: SharedArrayBuffer): number;
    releaseBuffer(buffer: number): void;
    begin(concurrent: boolean): void;
    barrier(): void;
    setPipeline(pipeline: number): void;
    setBuffer(index: number, buffer: number, byteOffset: number): void;
    setBytes(index: number, data: ArrayBufferView | ArrayBuffer): void;
    dispatch(gx: number, gy: number, gz: number, tx: number, ty: number, tz: number): void;
    commit(): void;
    wait(): void;
    discard(): void;
  };
}
const host = __garnet_metal;

/** Whether this process has a Metal device (the framework is loaded on the first call). */
export function available(): boolean { return host.available(); }
/** The device's name, "" without a device. */
export function deviceName(): string { return host.deviceName(); }
export interface CompileOptions {
  /** reassociation and contraction allowed in the kernels (off by default) */
  fastMath?: boolean;
  /** the Metal Shading Language version as "major.minor" (the compiler's default when absent;
   *  "4.0" for the Metal 4 tensor headers); a malformed one is a RangeError */
  languageVersion?: string;
}

/** Kernels compiled from Metal Shading Language source. */
export class Library {
  /** the host's handle */
  readonly handle: number;
  constructor(source: string, options?: CompileOptions) {
    if (typeof source !== "string") throw new TypeError("garnet:metal: the kernel source must be a string");
    this.handle = host.compile(source, options !== undefined && options.fastMath === true, options !== undefined ? options.languageVersion : undefined);
  }
  /** The compute pipeline of the kernel function `name`. */
  pipeline(name: string): Pipeline { return new Pipeline(this, name); }
}

/** A compute pipeline: one kernel function, ready to dispatch. */
export class Pipeline {
  readonly handle: number;
  readonly name: string;
  /** the most threads one threadgroup of this kernel may have */
  readonly maxThreadsPerThreadgroup: number;
  /** the SIMD group width (threads that execute in lockstep) */
  readonly threadExecutionWidth: number;
  constructor(library: Library, name: string) {
    if (typeof name !== "string") throw new TypeError("garnet:metal: the kernel name must be a string");
    this.name = name;
    this.handle = host.pipeline(library.handle, name);
    this.maxThreadsPerThreadgroup = host.pipelineMaxThreads(this.handle);
    this.threadExecutionWidth = host.pipelineSimdWidth(this.handle);
  }
}

/** A buffer the GPU reads and writes in place: the SharedArrayBuffer's own pages. */
export class GpuBuffer {
  private handle: number;
  readonly storage: SharedArrayBuffer;
  readonly byteLength: number;
  constructor(storage: SharedArrayBuffer) {
    if (!(storage instanceof SharedArrayBuffer)) throw new TypeError("garnet:metal: a GpuBuffer takes a SharedArrayBuffer");
    this.storage = storage;
    this.byteLength = storage.byteLength;
    this.handle = host.buffer(storage);
  }
  /** the host's handle (an Error once released) */
  id(): number {
    if (this.handle < 0) throw new Error("garnet:metal: the buffer was released");
    return this.handle;
  }
  /** Releases the Metal buffer (the SharedArrayBuffer itself stays the program's). */
  release(): void {
    if (this.handle >= 0) { host.releaseBuffer(this.handle); this.handle = -1; }
  }
}

export interface CommandBufferOptions {
  /** independent dispatches may run at once and barrier() orders the dependent ones (serial by
   *  default: each dispatch sees the previous one's writes) */
  concurrent?: boolean;
}

/** One command buffer: dispatches encoded in order, one commit, one wait. One is open at a time. */
export class CommandBuffer {
  /** whether the dispatches may overlap (barrier() separates the dependent ones) */
  readonly concurrent: boolean;
  constructor(options?: CommandBufferOptions) {
    this.concurrent = options !== undefined && options.concurrent === true;
    host.begin(this.concurrent);
  }
  /** On a concurrent command buffer, the dispatches after it see the writes of those before it (nothing on a serial one). */
  barrier(): void { host.barrier(); }
  /** The kernel of the following dispatches. */
  pipeline(p: Pipeline): void { host.setPipeline(p.handle); }
  /** Binds `b` at `byteOffset` to the kernel's buffer `index`. */
  buffer(index: number, b: GpuBuffer, byteOffset: number = 0): void { host.setBuffer(index, b.id(), byteOffset); }
  /** Copies `data` (an argument struct, at most 4 KB) as the kernel's buffer `index`. */
  bytes(index: number, data: ArrayBufferView | ArrayBuffer): void { host.setBytes(index, data); }
  /** A one-dimensional dispatch. */
  dispatch(threadgroups: number, threadsPerThreadgroup: number): void { host.dispatch(threadgroups, 1, 1, threadsPerThreadgroup, 1, 1); }
  /** A three-dimensional dispatch: threadgroups and threads per threadgroup. */
  dispatch3(gx: number, gy: number, gz: number, tx: number, ty: number, tz: number): void { host.dispatch(gx, gy, gz, tx, ty, tz); }
  /** Ends the encoding and submits the command buffer. */
  commit(): void { host.commit(); }
  /** Waits for the committed command buffer; its failure is thrown. */
  wait(): void { host.wait(); }
  /** Drops the command buffer without running it. */
  discard(): void { host.discard(); }
}
