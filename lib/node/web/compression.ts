// CompressionStream and DecompressionStream (docs/web_compression_design.md): the gzip, deflate and
// deflate-raw formats over the system's zlib (runtime/zlib_host.c), a readable and writable pair
// as Node's own is (its zlib stream behind the readable/writable adapter): the writable side takes a
// string as UTF-8 and any ArrayBufferView (an ArrayBuffer or another value is Node's TypeError), the
// readable side hands out the output as Node's zlib cuts it, a zlib failure is Node's TypeError
// carrying the zlib error as its cause and its code, and data after a gzip or deflate stream's end is
// Node's trailing-junk TypeError (a deflate-raw stream's readable side ends there instead). Node's
// brotli format is a TypeError: garnet has no brotli codec. Under the V8 oracle the globals are
// Node's own, whose behaviour these follow.
import { host } from "../host";
import { codedTypeError, invalidArgType } from "../errors";
import { ByteLengthQueuingStrategy, ReadableStream, WritableStream } from "./streams";
import type { ReadableStreamDefaultController, WritableStreamDefaultController } from "./streams";

export type CompressionFormat = "deflate" | "deflate-raw" | "gzip";
const FORMATS = ["deflate", "deflate-raw", "gzip"];
// Node's zlib streams: 64 KiB high-water marks (the writable's counts chunks, as its adapter's does)
const HIGH_WATER_MARK = 65536;
const EMPTY = new Uint8Array(0);

/** The zlib mode of a format (runtime/zlib_host.c): its index, plus 3 to decompress. */
function modeOf(format: unknown, ctor: string): number {
  const name = String(format);
  const mode = FORMATS.indexOf(name);
  if (mode >= 0) return mode;
  if (name === "brotli") throw new TypeError(`Failed to construct '${ctor}': the 'brotli' format is not supported (garnet has no brotli codec)`);
  throw codedTypeError("ERR_INVALID_ARG_VALUE", `Failed to construct '${ctor}': 1st argument value '${name}' is not a valid enum value of type CompressionFormat.`);
}
function isView(v: unknown): v is ArrayBufferView {
  return typeof v === "object" && v !== null && typeof (v as ArrayBufferView).byteLength === "number" &&
    typeof (v as ArrayBufferView).byteOffset === "number" && (v as ArrayBufferView).buffer instanceof ArrayBuffer;
}
/** A chunk's bytes as Node's writable side takes them. */
function chunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk === null) throw codedTypeError("ERR_STREAM_NULL_VALUES", "May not write null values to stream");
  if (ArrayBuffer.isView(chunk) || isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw invalidArgType("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
}
/** Node's error for a zlib failure: the zlib error (its message, errno and code) as the cause of
 *  a TypeError that carries the code and no message (its webstreams adapter's conversion). */
function zlibFailure(info: [string, string, number]): TypeError {
  const cause = new Error(info[0]) as Error & { errno: number; code: string };
  cause.errno = info[2];
  cause.code = info[1];
  const e = new TypeError() as TypeError & { code: string };
  Object.defineProperty(e, "cause", { value: cause, writable: true, enumerable: false, configurable: true });
  e.code = info[1];
  return e;
}

/** One zlib stream behind a readable and a writable side. */
class ZlibPair {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<unknown>;
  #handle: object | undefined;   // the stream (its ArrayBuffer); dropped when it ends or fails
  readonly #rejectTrailing: boolean;
  #rc: ReadableStreamDefaultController<Uint8Array> | undefined = undefined;
  #wc: WritableStreamDefaultController | undefined = undefined;
  #ended = false;                // a deflate-raw stream's data ended: its readable side closed
  #failure: unknown = undefined;  // a zlib failure not yet reported to the writable side
  #resume: (() => void) | undefined = undefined;   // the write waiting for the reader
  readonly #out: Uint8Array[] = [];
  constructor(mode: number) {
    const opened = host.zlibOpen(mode);
    if (typeof opened === "string") throw new Error(`garnet: ${opened}`);
    this.#handle = opened;
    this.#rejectTrailing = mode === 3 || mode === 5;   // inflate and gunzip: Node's rejectGarbageAfterEnd
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => { this.#rc = c; },
      pull: () => { this.#release(); },
      cancel: (reason) => { this.#handle = undefined; this.#wc!.error(reason); this.#release(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER_MARK }));
    this.writable = new WritableStream<unknown>({
      start: (c) => { this.#wc = c; },
      write: (chunk) => this.#write(chunk),
      close: () => this.#close(),
      abort: (reason) => { this.#handle = undefined; this.#rc!.error(reason); this.#release(); },
    }, { highWaterMark: HIGH_WATER_MARK });
  }
  #release(): void {
    const resume = this.#resume;
    this.#resume = undefined;
    if (resume !== undefined) resume();
  }
  /** The stream over `bytes`, its output enqueued; the failure (the readable side errored with it), if any. */
  #run(bytes: Uint8Array, finish: boolean): unknown {
    const handle = this.#handle!;
    const out = this.#out;
    const status = host.zlibWrite(handle, bytes, finish, out);
    const rc = this.#rc!;
    if (this.readable.__state === "readable") for (const chunk of out) rc.enqueue(chunk);
    out.length = 0;
    let failure: unknown = undefined;
    if (status < 0) failure = zlibFailure(host.zlibError(handle));
    else if (status > 0) {
      if (this.#rejectTrailing) failure = codedTypeError("ERR_TRAILING_JUNK_AFTER_STREAM_END", "Trailing junk found after the end of the compressed stream");
      else {
        // a raw stream: the readable side ends (Node pushes the end) and later input is ignored
        this.#ended = true;
        if (this.readable.__state === "readable") rc.close();
      }
    }
    if (failure !== undefined) { this.#handle = undefined; rc.error(failure); }
    return failure;
  }
  #write(chunk: unknown): Promise<void> | undefined {
    let bytes: Uint8Array;
    try { bytes = chunkBytes(chunk); } catch (e) { this.#handle = undefined; this.#rc!.error(e); throw e; }
    if (this.#handle === undefined || this.#ended) return undefined;
    const failure = this.#run(bytes, false);
    if (failure !== undefined) {
      // Node's zlib fails on its thread pool, after the write resolved: until the failure lands
      // (the next turn of the loop) writes resolve and a close fails with it; then the writable
      // side is errored by it (a later close refuses with ERR_INVALID_STATE)
      this.#failure = failure;
      host.immediate(() => { if (this.writable.__state === "writable") this.#wc!.error(failure); }, undefined);
      return undefined;
    }
    // backpressure: a full readable side holds the write until the reader pulls (or cancels)
    if (this.readable.__state !== "readable" || (this.#rc!.desiredSize ?? 1) > 0) return undefined;
    return new Promise<void>((resolve) => { this.#resume = resolve; });
  }
  #close(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#handle !== undefined && !this.#ended) {
      const failure = this.#run(EMPTY, true);
      if (failure !== undefined) throw failure;
    }
    this.#handle = undefined;
    if (this.readable.__state === "readable") this.#rc!.close();
  }
}

export class CompressionStream {
  readonly #pair: ZlibPair;
  constructor(format: CompressionFormat) { this.#pair = new ZlibPair(modeOf(format, "CompressionStream")); }
  get readable(): ReadableStream<Uint8Array> { return this.#pair.readable; }
  get writable(): WritableStream<unknown> { return this.#pair.writable; }
  get [Symbol.toStringTag](): string { return "CompressionStream"; }
}

export class DecompressionStream {
  readonly #pair: ZlibPair;
  constructor(format: CompressionFormat) { this.#pair = new ZlibPair(modeOf(format, "DecompressionStream") + 3); }
  get readable(): ReadableStream<Uint8Array> { return this.#pair.readable; }
  get writable(): WritableStream<unknown> { return this.#pair.writable; }
  get [Symbol.toStringTag](): string { return "DecompressionStream"; }
}
