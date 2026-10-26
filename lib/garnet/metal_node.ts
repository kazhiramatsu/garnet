// garnet:metal under Node (scripts/garnet_scheme_loader.mjs): no Metal. available() is
// false, deviceName() is empty, and a Library, a GpuBuffer or a CommandBuffer throws the
// same Error as the binding where Metal is absent, after the same argument checks, so a
// program's `available()` branch is the only difference between the engines.

export function available(): boolean { return false; }
export function deviceName(): string { return ""; }
export interface CompileOptions { fastMath?: boolean }
function unavailable(): Error { return new Error("garnet:metal: Metal is not available"); }

export class Library {
  readonly handle: number = -1;
  constructor(source: string, options?: CompileOptions) {
    if (typeof source !== "string") throw new TypeError("garnet:metal: the kernel source must be a string");
    void options;
    throw unavailable();
  }
  pipeline(name: string): Pipeline { return new Pipeline(this, name); }
}
export class Pipeline {
  readonly handle: number = -1;
  readonly name: string;
  readonly maxThreadsPerThreadgroup: number = 0;
  readonly threadExecutionWidth: number = 0;
  constructor(library: Library, name: string) {
    if (typeof name !== "string") throw new TypeError("garnet:metal: the kernel name must be a string");
    void library;
    this.name = name;
    throw unavailable();
  }
}
export class GpuBuffer {
  readonly storage: SharedArrayBuffer;
  readonly byteLength: number;
  constructor(storage: SharedArrayBuffer) {
    if (!(storage instanceof SharedArrayBuffer)) throw new TypeError("garnet:metal: a GpuBuffer takes a SharedArrayBuffer");
    this.storage = storage;
    this.byteLength = storage.byteLength;
    throw unavailable();
  }
  id(): number { throw unavailable(); }
  release(): void {}
}
export class CommandBuffer {
  constructor() { throw unavailable(); }
  pipeline(p: Pipeline): void { void p; throw unavailable(); }
  buffer(index: number, b: GpuBuffer, byteOffset: number = 0): void { void index; void b; void byteOffset; throw unavailable(); }
  bytes(index: number, data: ArrayBufferView | ArrayBuffer): void { void index; void data; throw unavailable(); }
  dispatch(threadgroups: number, threadsPerThreadgroup: number): void { void threadgroups; void threadsPerThreadgroup; throw unavailable(); }
  dispatch3(gx: number, gy: number, gz: number, tx: number, ty: number, tz: number): void { void gx; void gy; void gz; void tx; void ty; void tz; throw unavailable(); }
  commit(): void { throw unavailable(); }
  wait(): void { throw unavailable(); }
  discard(): void {}
}
