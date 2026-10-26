// node:stream (docs/node_compat_design.md): Readable, Writable, Duplex,
// Transform and PassThrough with Node's state machines (paused and flowing
// modes, highWaterMark and backpressure, 'readable'/'data'/'end'/'finish'/
// 'close' in Node's order, autoDestroy), pipe, pipeline, finished,
// Readable.from and async iteration. The logic is ported from Node's
// lib/internal/streams; the writable half is a set of functions over a
// WritableState so that Duplex (which extends Readable) shares it.
import { EventEmitter } from "./events";
import { Buffer, fromView } from "./buffer";
import { StringDecoder } from "./string_decoder";
import { host } from "./host";
import { codedError, codedTypeError, codedRangeError, invalidArgType } from "./errors";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Callback = (error?: Error | null) => void;
/** A destination of pipe: a Writable, or a Duplex (Transform, PassThrough) by its writable half. */
export type Sink = Writable | Duplex;
type AnyFunction = (...args: any[]) => any;
function nextTick(fn: AnyFunction, ...args: any[]): void { host.nextTick(fn, args.length === 0 ? undefined : args); }
function nop(): void {}
function isUint8Array(value: unknown): value is Uint8Array { return value instanceof Uint8Array; }
function asBuffer(value: Uint8Array): Buffer { return value instanceof Buffer ? (value as Buffer) : fromView(value); }

// ---- errors ----
function errStreamPushAfterEof(): Error { return codedError("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF"); }
function errStreamUnshiftAfterEnd(): Error { return codedError("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event"); }
function errStreamWriteAfterEnd(): Error { return codedError("ERR_STREAM_WRITE_AFTER_END", "write after end"); }
function errStreamDestroyed(method: string): Error { return codedError("ERR_STREAM_DESTROYED", `Cannot call ${method} after a stream was destroyed`); }
function errStreamAlreadyFinished(method: string): Error { return codedError("ERR_STREAM_ALREADY_FINISHED", `Cannot call ${method} after a stream was finished`); }
function errStreamNullValues(): TypeError { return codedTypeError("ERR_STREAM_NULL_VALUES", "May not write null values to stream"); }
function errMethodNotImplemented(name: string): Error { return codedError("ERR_METHOD_NOT_IMPLEMENTED", `The ${name} method is not implemented`); }
function errMultipleCallback(): Error { return codedError("ERR_MULTIPLE_CALLBACK", "Callback called multiple times"); }
function errPrematureClose(): Error { return codedError("ERR_STREAM_PREMATURE_CLOSE", "Premature close"); }
function errUnknownEncoding(encoding: string): TypeError { return codedTypeError("ERR_UNKNOWN_ENCODING", `Unknown encoding: ${encoding}`); }
function errInvalidChunk(chunk: unknown): TypeError { return invalidArgType("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk); }
function errInvalidReturnValue(what: string, name: string, value: unknown): TypeError {
  return codedTypeError("ERR_INVALID_RETURN_VALUE", `Expected ${what} to be returned from the "${name}" function but got ${typeof value}.`);
}
function errMissingArgs(name: string): TypeError { return codedTypeError("ERR_MISSING_ARGS", `The "${name}" argument must be specified`); }
function highWaterMarkFrom(options: { highWaterMark?: number; objectMode?: boolean; [key: string]: unknown } | undefined, isDuplex: boolean, duplexKey: string): number | null {
  if (options === undefined) return null;
  let hwm: unknown = options.highWaterMark;
  if (hwm === undefined && isDuplex) hwm = options[duplexKey];
  if (hwm === undefined || hwm === null) return null;
  if (typeof hwm !== "number" || !Number.isInteger(hwm) || hwm < 0) {
    throw codedTypeError("ERR_INVALID_ARG_VALUE", `The property 'options.${isDuplex ? duplexKey : "highWaterMark"}' is invalid. Received ${String(hwm)}`);
  }
  return hwm;
}
function defaultHighWaterMark(objectMode: boolean): number { return objectMode ? 16 : 65536; }

// ---- options ----
export interface StreamOptions {
  highWaterMark?: number;
  objectMode?: boolean;
  emitClose?: boolean;
  autoDestroy?: boolean;
  destroy?: (this: Stream, error: Error | null, callback: (error?: Error | null) => void) => void;
  /** Asynchronous setup (opening a file): writes buffer and reads wait until the callback. */
  construct?: (this: Stream, callback: (error?: Error | null) => void) => void;
  signal?: unknown;
}
export interface ReadableOptions extends StreamOptions {
  encoding?: string;
  readable?: boolean;
  read?: (this: Readable, size: number) => void;
  readableObjectMode?: boolean;
  readableHighWaterMark?: number;
}
export interface WritableOptions extends StreamOptions {
  decodeStrings?: boolean;
  defaultEncoding?: string;
  write?: (this: Writable, chunk: any, encoding: string, callback: (error?: Error | null) => void) => void;
  writev?: (this: Writable, chunks: { chunk: any; encoding: string }[], callback: (error?: Error | null) => void) => void;
  final?: (this: Writable, callback: (error?: Error | null) => void) => void;
  writableObjectMode?: boolean;
  writableHighWaterMark?: number;
}
export interface DuplexOptions extends ReadableOptions, WritableOptions {
  allowHalfOpen?: boolean;
  readable?: boolean;
  writable?: boolean;
}
export interface TransformOptions extends DuplexOptions {
  transform?: (this: Transform, chunk: any, encoding: string, callback: (error?: Error | null, data?: any) => void) => void;
  flush?: (this: Transform, callback: (error?: Error | null, data?: any) => void) => void;
}

// ---- the legacy base: an EventEmitter with pipe ----
export class Stream extends EventEmitter {
  /** The writable half's state when this stream has one (Writable, Duplex). */
  _writableState: WritableState | undefined = undefined;
  /** The readable half's state when this stream has one (Readable, Duplex). */
  _readableState: ReadableState | undefined = undefined;
  /** Set on process.stdout and process.stderr: a pipe never ends them. */
  isStdio: boolean = false;
  /** A destroy requested before construction finished: run when it does. */
  pendingDestroy: { error: Error | null; callback: Callback | undefined } | null = null;
  constructor(_options?: StreamOptions) { super(); }
  pipe<T extends Sink>(dest: T, options?: { end?: boolean }): T {
    const source = this as unknown as { on: Stream["on"]; resume?: () => void };
    source.on("data", (chunk: any) => { if (dest.write(chunk) === false && source.resume !== undefined) { /* legacy: no backpressure */ } });
    if (options === undefined || options.end !== false) source.on("end", () => { dest.end(); });
    return dest;
  }
}

// ======================= Readable =======================
export class ReadableState {
  objectMode: boolean;
  highWaterMark: number;
  buffer: any[] = [];
  bufferIndex = 0;
  length = 0;
  pipes: Sink[] = [];
  awaitDrainWriters: Set<Sink> | Sink | null = null;
  multiAwaitDrain = false;
  flowing: boolean | null = null;
  ended = false;
  endEmitted = false;
  reading = false;
  constructed = true;
  sync = true;
  needReadable = false;
  emittedReadable = false;
  readableListening = false;
  resumeScheduled = false;
  errorEmitted = false;
  emitClose: boolean;
  autoDestroy: boolean;
  destroyed = false;
  errored: Error | null = null;
  closed = false;
  closeEmitted = false;
  defaultEncoding: string;
  readingMore = false;
  dataEmitted = false;
  paused = false;
  readable: boolean = true;
  decoder: StringDecoder | null = null;
  encoding: string | null = null;
  constructor(options: ReadableOptions | undefined, isDuplex: boolean) {
    this.objectMode = !!(options && (options.objectMode || (isDuplex && options.readableObjectMode)));
    const hwm = highWaterMarkFrom(options as { highWaterMark?: number } | undefined, isDuplex, "readableHighWaterMark");
    this.highWaterMark = hwm === null ? defaultHighWaterMark(this.objectMode) : hwm;
    this.emitClose = !options || options.emitClose !== false;
    this.autoDestroy = !options || options.autoDestroy !== false;
    this.defaultEncoding = "utf8";
    if (options && options.encoding) {
      this.decoder = new StringDecoder(options.encoding);
      this.encoding = options.encoding;
    }
  }
}

export class Readable extends Stream {
  _readableState: ReadableState;
  private readImpl: ((this: Readable, size: number) => void) | undefined;
  private destroyImpl: ((this: Stream, error: Error | null, callback: (error?: Error | null) => void) => void) | undefined;
  /** Duplex: the writable half ends when the readable half does (allowHalfOpen false). */
  allowHalfOpen: boolean = true;
  constructor(options?: ReadableOptions) {
    super(options);
    const isDuplex = this instanceof Duplex;
    this._readableState = new ReadableState(options, isDuplex);
    if (options) {
      if (typeof options.read === "function") this.readImpl = options.read;
      if (typeof options.destroy === "function") this.destroyImpl = options.destroy;
      if (options.readable === false) this._readableState.readable = false;
      if (typeof options.construct === "function" && !isDuplex) constructStream(this, options.construct);
    }
  }
  /** Readable.from(iterable): a readable of the iterable's values (an async iterable
   *  is awaited), in object mode unless told otherwise. A string or a Buffer is one chunk. */
  static from(iterable: Iterable<any> | AsyncIterable<any> | string | Uint8Array, options?: ReadableOptions): Readable {
    return readableFrom(iterable, options);
  }
  _read(size: number): void {
    if (this.readImpl !== undefined) { this.readImpl.call(this, size); return; }
    throw errMethodNotImplemented("_read()");
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.destroyImpl !== undefined) { this.destroyImpl.call(this, error, callback); return; }
    callback(error);
  }
  push(chunk: any, encoding?: string): boolean { return readableAddChunk(this, chunk, encoding, false); }
  unshift(chunk: any, encoding?: string): boolean { return readableAddChunk(this, chunk, encoding, true); }
  isPaused(): boolean { const state = this._readableState; return state.paused === true || state.flowing === false; }
  setEncoding(encoding: string): this {
    const decoder = new StringDecoder(encoding);
    const state = this._readableState;
    state.decoder = decoder;
    state.encoding = encoding;
    let content = "";
    for (let i = state.bufferIndex; i < state.buffer.length; i++) content += decoder.write(state.buffer[i]);
    state.buffer = [];
    state.bufferIndex = 0;
    if (content !== "") state.buffer.push(content);
    state.length = content.length;
    return this;
  }
  read(n?: number): any {
    let count: number;
    if (n === undefined) count = NaN;
    else if (!Number.isInteger(n)) count = parseInt(String(n), 10);
    else count = n;
    const state = this._readableState;
    const nOrig = count;
    if (count > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(count);
    if (count !== 0) state.emittedReadable = false;
    if (count === 0 && state.needReadable &&
        ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
      if (state.length === 0 && state.ended) endReadable(this);
      else emitReadable(this);
      return null;
    }
    count = howMuchToRead(count, state);
    if (count === 0 && state.ended) {
      if (state.length === 0) endReadable(this);
      return null;
    }
    let doRead = state.needReadable;
    if (state.length === 0 || state.length - count < state.highWaterMark) doRead = true;
    if (state.ended || state.reading || state.destroyed || state.errored !== null || !state.constructed) doRead = false;
    else if (doRead) {
      state.reading = true;
      state.sync = true;
      if (state.length === 0) state.needReadable = true;
      try { this._read(state.highWaterMark); } catch (err) { errorOrDestroy(this, err as Error); }
      state.sync = false;
      if (!state.reading) count = howMuchToRead(nOrig, state);
    }
    let ret: any = null;
    if (count > 0) ret = fromList(count, state);
    if (ret === null) {
      state.needReadable = state.length <= state.highWaterMark;
      count = 0;
    } else {
      state.length -= count;
      if (state.multiAwaitDrain) (state.awaitDrainWriters as Set<Sink>).clear();
      else state.awaitDrainWriters = null;
    }
    if (state.length === 0) {
      if (!state.ended) state.needReadable = true;
      if (nOrig !== count && state.ended) endReadable(this);
    }
    if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
      state.dataEmitted = true;
      this.emit("data", ret);
    }
    return ret;
  }
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    const state = this._readableState;
    if (event === "data") {
      state.readableListening = this.listenerCount("readable") > 0;
      if (state.flowing !== false) this.resume();
    } else if (event === "readable") {
      if (!state.endEmitted && !state.readableListening) {
        state.readableListening = state.needReadable = true;
        state.flowing = false;
        state.emittedReadable = false;
        if (state.length) emitReadable(this);
        else if (!state.reading) nextTick(() => { this.read(0); });
      }
    }
    return this;
  }
  addListener(event: string | symbol, listener: (...args: any[]) => void): this { return this.on(event, listener); }
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    super.removeListener(event, listener);
    if (event === "readable") nextTick(() => updateReadableListening(this));
    return this;
  }
  off(event: string | symbol, listener: (...args: any[]) => void): this { return this.removeListener(event, listener); }
  removeAllListeners(event?: string | symbol): this {
    super.removeAllListeners(event);
    if (event === "readable" || event === undefined) nextTick(() => updateReadableListening(this));
    return this;
  }
  resume(): this {
    const state = this._readableState;
    if (!state.flowing) {
      state.flowing = !state.readableListening;
      if (!state.resumeScheduled) {
        state.resumeScheduled = true;
        nextTick(() => {
          if (!state.reading) this.read(0);
          state.resumeScheduled = false;
          this.emit("resume");
          flow(this);
          if (state.flowing && !state.reading) this.read(0);
        });
      }
    }
    state.paused = false;
    return this;
  }
  pause(): this {
    const state = this._readableState;
    if (state.flowing !== false) {
      state.flowing = false;
      this.emit("pause");
    }
    state.paused = true;
    return this;
  }
  pipe<T extends Sink>(dest: T, pipeOpts?: { end?: boolean }): T {
    const src = this;
    const state = this._readableState;
    state.pipes.push(dest);
    const doEnd = (!pipeOpts || pipeOpts.end !== false) && !dest.isStdio;
    const endFn = doEnd ? onend : unpipe;
    if (state.endEmitted) nextTick(endFn);
    else src.once("end", endFn);
    dest.on("unpipe", onunpipe);
    function onunpipe(readable: Readable, unpipeInfo: { hasUnpiped: boolean }): void {
      if (readable === src && unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
    function onend(): void { dest.end(); }
    let ondrain: (() => void) | undefined;
    let cleanedUp = false;
    function cleanup(): void {
      dest.removeListener("close", onclose);
      dest.removeListener("finish", onfinish);
      if (ondrain !== undefined) dest.removeListener("drain", ondrain);
      dest.removeListener("error", onerror);
      dest.removeListener("unpipe", onunpipe);
      src.removeListener("end", onend);
      src.removeListener("end", unpipe);
      src.removeListener("data", ondata);
      cleanedUp = true;
      if (ondrain !== undefined && state.awaitDrainWriters !== null && (!dest._writableState || dest._writableState.needDrain)) ondrain();
    }
    function pause(): void {
      if (!cleanedUp) {
        if (state.pipes.length === 1 && state.pipes[0] === dest) {
          state.awaitDrainWriters = dest;
          state.multiAwaitDrain = false;
        } else if (state.pipes.length > 1 && state.pipes.indexOf(dest) >= 0) {
          (state.awaitDrainWriters as Set<Sink>).add(dest);
        }
        src.pause();
      }
      if (ondrain === undefined) {
        ondrain = pipeOnDrain(src, dest);
        dest.on("drain", ondrain);
      }
    }
    src.on("data", ondata);
    function ondata(chunk: any): void {
      const ret = dest.write(chunk);
      if (ret === false) pause();
    }
    function onerror(er: Error): void {
      unpipe();
      dest.removeListener("error", onerror);
      if (dest.listenerCount("error") === 0) {
        const s = dest._writableState || dest._readableState;
        if (s && !s.errorEmitted) errorOrDestroy(dest, er);
        else dest.emit("error", er);
      }
    }
    dest.prependListener("error", onerror);
    function onclose(): void {
      dest.removeListener("finish", onfinish);
      unpipe();
    }
    dest.once("close", onclose);
    function onfinish(): void {
      dest.removeListener("close", onclose);
      unpipe();
    }
    dest.once("finish", onfinish);
    function unpipe(): void { src.unpipe(dest); }
    dest.emit("pipe", src);
    if (dest.writableNeedDrain === true) pause();
    else if (!state.flowing) src.resume();
    return dest;
  }
  unpipe(dest?: Sink): this {
    const state = this._readableState;
    const unpipeInfo = { hasUnpiped: false };
    if (state.pipes.length === 0) return this;
    if (!dest) {
      const dests = state.pipes;
      state.pipes = [];
      this.pause();
      for (let i = 0; i < dests.length; i++) dests[i].emit("unpipe", this, { hasUnpiped: false });
      return this;
    }
    const index = state.pipes.indexOf(dest);
    if (index === -1) return this;
    state.pipes.splice(index, 1);
    if (state.pipes.length === 0) this.pause();
    dest.emit("unpipe", this, unpipeInfo);
    return this;
  }
  destroy(error?: Error | null, callback?: (error?: Error | null) => void): this {
    destroyStream(this, error === undefined ? null : error, callback);
    return this;
  }
  /** Node's experimental helpers: the chunks collected into an array. */
  async toArray(): Promise<any[]> {
    const out: any[] = [];
    for await (const chunk of this) out.push(chunk);
    return out;
  }
  get readable(): boolean {
    const r = this._readableState;
    return !!r && r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
  }
  set readable(value: boolean) { this._readableState.readable = !!value; }
  get readableEnded(): boolean { return this._readableState.endEmitted; }
  get readableFlowing(): boolean | null { return this._readableState.flowing; }
  set readableFlowing(value: boolean | null) { this._readableState.flowing = value; }
  get readableLength(): number { return this._readableState.length; }
  get readableHighWaterMark(): number { return this._readableState.highWaterMark; }
  get readableObjectMode(): boolean { return this._readableState.objectMode; }
  get readableEncoding(): string | null { return this._readableState.encoding; }
  get readableDidRead(): boolean { return this._readableState.dataEmitted; }
  get readableAborted(): boolean {
    const r = this._readableState;
    return r.readable !== false && (r.destroyed || r.errored !== null) && !r.endEmitted;
  }
  get destroyed(): boolean { return this._readableState.destroyed; }
  set destroyed(value: boolean) { this._readableState.destroyed = value; }
  get errored(): Error | null { return this._readableState.errored; }
  get closed(): boolean { return this._readableState.closed; }
  async *[Symbol.asyncIterator](): AsyncGenerator<any, void, undefined> {
    const stream = this;
    let callback: (() => void) | null = null;
    const onreadable = (): void => { if (callback !== null) { const cb = callback; callback = null; cb(); } };
    stream.on("readable", onreadable);
    let error: Error | null | undefined = undefined;
    const cleanup = finished(stream, { writable: false }, (err) => {
      error = err ? err : null;
      onreadable();
    });
    try {
      for (;;) {
        const chunk = stream.destroyed ? null : stream.read();
        if (chunk !== null) yield chunk;
        else if (error) throw error;
        else if (error === null) return;
        else await new Promise<void>((resolve) => { callback = resolve; });
      }
    } catch (err) {
      error = err as Error;
      throw err;
    } finally {
      if ((error || true) && (error === undefined || stream._readableState.autoDestroy)) {
        destroyStream(stream, null, undefined);
      } else {
        stream.off("readable", onreadable);
        cleanup();
      }
    }
  }
}

function computeNewHighWaterMark(n: number): number {
  if (n > 0x40000000) throw codedRangeError("ERR_OUT_OF_RANGE", `The value of "size" is out of range. It must be <= 1GiB. Received ${n}`);
  n--;
  n |= n >>> 1; n |= n >>> 2; n |= n >>> 4; n |= n >>> 8; n |= n >>> 16;
  n++;
  return n;
}
function howMuchToRead(n: number, state: ReadableState): number {
  if (n <= 0 || (state.length === 0 && state.ended)) return 0;
  if (state.objectMode) return 1;
  if (Number.isNaN(n)) {
    if (state.flowing && state.length) return (state.buffer[state.bufferIndex] as Buffer | string).length;
    return state.length;
  }
  if (n <= state.length) return n;
  return state.ended ? state.length : 0;
}
function bufferedChunks(state: ReadableState): any[] {
  if (state.bufferIndex > 0) { state.buffer = state.buffer.slice(state.bufferIndex); state.bufferIndex = 0; }
  return state.buffer;
}
/** `n` units (bytes, or characters after setEncoding) off the front of the buffer; everything for n >= length. */
function fromList(n: number, state: ReadableState): any {
  if (state.length === 0) return null;
  const buffer = bufferedChunks(state);
  let ret: any;
  if (state.objectMode) ret = buffer.shift();
  else if (!n || n >= state.length) {
    if (state.decoder) ret = buffer.join("");
    else if (buffer.length === 1) ret = buffer[0];
    else ret = Buffer.concat(buffer, state.length);
    state.buffer = [];
  } else {
    // less than the whole buffer
    const first = buffer[0] as Buffer | string;
    if (n < first.length) {
      ret = first.slice(0, n);
      buffer[0] = first.slice(n);
    } else if (n === first.length) {
      ret = buffer.shift();
    } else {
      const parts: any[] = [];
      let remaining = n;
      while (remaining > 0) {
        const chunk = buffer[0] as Buffer | string;
        if (chunk.length <= remaining) { parts.push(buffer.shift()); remaining -= chunk.length; }
        else { parts.push(chunk.slice(0, remaining)); buffer[0] = chunk.slice(remaining); remaining = 0; }
      }
      ret = state.decoder ? parts.join("") : Buffer.concat(parts, n);
    }
  }
  return ret;
}
function readableAddChunk(stream: Readable, chunk: any, encoding: string | undefined, addToFront: boolean): boolean {
  const state = stream._readableState;
  let err: Error | undefined;
  if (!state.objectMode) {
    if (typeof chunk === "string") {
      encoding = encoding || state.defaultEncoding;
      if (state.encoding !== encoding) {
        if (addToFront && state.encoding) chunk = Buffer.from(chunk, encoding).toString(state.encoding);
        else { chunk = Buffer.from(chunk, encoding); encoding = ""; }
      }
    } else if (chunk instanceof Buffer) encoding = "";
    else if (isUint8Array(chunk)) { chunk = asBuffer(chunk); encoding = ""; }
    else if (chunk !== null && chunk !== undefined) err = errInvalidChunk(chunk);
  }
  if (err) errorOrDestroy(stream, err);
  else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || (chunk && (chunk as Buffer | string).length > 0)) {
    if (addToFront) {
      if (state.endEmitted) errorOrDestroy(stream, errStreamUnshiftAfterEnd());
      else if (state.destroyed || state.errored !== null) return false;
      else addChunk(stream, state, chunk, true);
    } else if (state.ended) errorOrDestroy(stream, errStreamPushAfterEof());
    else if (state.destroyed || state.errored !== null) return false;
    else {
      state.reading = false;
      if (state.decoder && !encoding) {
        chunk = state.decoder.write(chunk);
        if (state.objectMode || (chunk as string).length !== 0) addChunk(stream, state, chunk, false);
        else maybeReadMore(stream, state);
      } else addChunk(stream, state, chunk, false);
    }
  } else if (!addToFront) {
    state.reading = false;
    maybeReadMore(stream, state);
  }
  return !state.ended && (state.length < state.highWaterMark || state.length === 0);
}
function addChunk(stream: Readable, state: ReadableState, chunk: any, addToFront: boolean): void {
  if (state.flowing && state.length === 0 && !state.sync && stream.listenerCount("data") > 0) {
    if (state.multiAwaitDrain) (state.awaitDrainWriters as Set<Sink>).clear();
    else state.awaitDrainWriters = null;
    state.dataEmitted = true;
    stream.emit("data", chunk);
  } else {
    state.length += state.objectMode ? 1 : (chunk as Buffer | string).length;
    if (addToFront) bufferedChunks(state).unshift(chunk);
    else state.buffer.push(chunk);
    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}
function onEofChunk(stream: Readable, state: ReadableState): void {
  if (state.ended) return;
  if (state.decoder) {
    const chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;
  if (state.sync) emitReadable(stream);
  else {
    state.needReadable = false;
    state.emittedReadable = true;
    emitReadableNow(stream);
  }
}
function emitReadable(stream: Readable): void {
  const state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(() => emitReadableNow(stream));
  }
}
function emitReadableNow(stream: Readable): void {
  const state = stream._readableState;
  if (!state.destroyed && state.errored === null && (state.length || state.ended)) {
    stream.emit("readable");
    state.emittedReadable = false;
  }
  state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
  flow(stream);
}
function maybeReadMore(stream: Readable, state: ReadableState): void {
  if (!state.readingMore && state.constructed) {
    state.readingMore = true;
    nextTick(() => {
      while (!state.reading && !state.ended && (state.length < state.highWaterMark || (state.flowing && state.length === 0))) {
        const len = state.length;
        stream.read(0);
        if (len === state.length) break;
      }
      state.readingMore = false;
    });
  }
}
function updateReadableListening(self: Readable): void {
  const state = self._readableState;
  state.readableListening = self.listenerCount("readable") > 0;
  if (state.resumeScheduled && state.paused === false) state.flowing = true;
  else if (self.listenerCount("data") > 0) self.resume();
  else if (!state.readableListening) state.flowing = null;
}
function flow(stream: Readable): void {
  const state = stream._readableState;
  while (state.flowing && stream.read() !== null) { /* each read emits 'data' */ }
}
function pipeOnDrain(src: Readable, dest: Sink): () => void {
  return function (): void {
    const state = src._readableState;
    if (state.awaitDrainWriters === dest) state.awaitDrainWriters = null;
    else if (state.multiAwaitDrain) (state.awaitDrainWriters as Set<Sink>).delete(dest);
    if ((state.awaitDrainWriters === null || (state.awaitDrainWriters instanceof Set && state.awaitDrainWriters.size === 0)) && src.listenerCount("data") > 0) {
      src.resume();
    }
  };
}
function endReadable(stream: Readable): void {
  const state = stream._readableState;
  if (!state.endEmitted) {
    state.ended = true;
    nextTick(() => endReadableNT(state, stream));
  }
}
function endReadableNT(state: ReadableState, stream: Readable): void {
  if (state.errored === null && !state.closeEmitted && !state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.emit("end");
    const w = stream._writableState;
    if (w !== undefined && stream.allowHalfOpen === false) {
      nextTick(() => { if (w.writable !== false && !w.ending && !w.destroyed) writableEnd(stream as unknown as WritableLike); });
    } else if (state.autoDestroy) {
      const autoDestroy = w === undefined || (w.autoDestroy && (w.finished || w.writable === false));
      if (autoDestroy) destroyStream(stream, null, undefined);
    }
  }
}
function readableFrom(iterable: Iterable<any> | AsyncIterable<any> | string | Uint8Array, options: ReadableOptions | undefined): Readable {
  if (typeof iterable === "string" || iterable instanceof Uint8Array) {
    const readable = new Readable({ objectMode: true, ...(options || {}) });
    let pushed = false;
    (readable as unknown as { readImpl: () => void }).readImpl = function (): void {
      if (!pushed) { pushed = true; readable.push(iterable); }
      readable.push(null);
    };
    return readable;
  }
  const isAsync = typeof (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
  const isSync = typeof (iterable as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
  if (!isAsync && !isSync) throw invalidArgType("iterable", "an instance of Iterable", iterable);
  async function* pull(): AsyncGenerator<any, void, undefined> {
    if (isAsync) { for await (const value of iterable as AsyncIterable<any>) yield value; }
    else { for (const value of iterable as Iterable<any>) yield value; }
  }
  const gen = pull();
  const readable = new Readable({ objectMode: true, highWaterMark: 1, ...(options || {}) });
  let reading = false;
  (readable as unknown as { readImpl: () => void }).readImpl = function (): void {
    if (!reading) { reading = true; next(); }
  };
  (readable as unknown as { destroyImpl: (error: Error | null, callback: (error?: Error | null) => void) => void }).destroyImpl =
    function (error: Error | null, callback: (error?: Error | null) => void): void {
      gen.return(undefined).then(() => nextTick(callback, error), (e: Error) => nextTick(callback, e || error));
    };
  async function next(): Promise<void> {
    for (;;) {
      try {
        const result = await gen.next();
        if (result.done) { readable.push(null); break; }
        const value = result.value;
        const resolved = value !== null && typeof value === "object" && typeof value.then === "function" ? await value : value;
        if (resolved === null) { reading = false; throw errStreamNullValues(); }
        if (readable.push(resolved)) continue;
        reading = false;
      } catch (err) {
        readable.destroy(err as Error);
      }
      break;
    }
  }
  return readable;
}

// ======================= Writable =======================
interface Buffered { chunk: any; encoding: string; callback: Callback }
export class WritableState {
  objectMode: boolean;
  highWaterMark: number;
  finalCalled = false;
  needDrain = false;
  ending = false;
  ended = false;
  finished = false;
  destroyed = false;
  decodeStrings: boolean;
  defaultEncoding: string;
  length = 0;
  writing = false;
  corked = 0;
  sync = true;
  bufferProcessing = false;
  writecb: Callback | null = null;
  writelen = 0;
  afterWriteTickInfo: { count: number; cb: Callback } | null = null;
  buffered: Buffered[] = [];
  bufferedIndex = 0;
  allBuffers = true;
  allNoop = true;
  pendingcb = 0;
  constructed = true;
  prefinished = false;
  errorEmitted = false;
  emitClose: boolean;
  autoDestroy: boolean;
  errored: Error | null = null;
  closed = false;
  closeEmitted = false;
  writable: boolean = true;
  onFinished: Callback[] = [];
  constructor(options: WritableOptions | undefined, isDuplex: boolean) {
    this.objectMode = !!(options && (options.objectMode || (isDuplex && options.writableObjectMode)));
    const hwm = highWaterMarkFrom(options as { highWaterMark?: number } | undefined, isDuplex, "writableHighWaterMark");
    this.highWaterMark = hwm === null ? defaultHighWaterMark(this.objectMode) : hwm;
    this.decodeStrings = !options || options.decodeStrings !== false;
    this.defaultEncoding = (options && options.defaultEncoding) || "utf8";
    this.emitClose = !options || options.emitClose !== false;
    this.autoDestroy = !options || options.autoDestroy !== false;
  }
}
/** What the writable functions need of a stream: Writable and Duplex both provide it. */
interface WritableLike extends Stream {
  _writableState: WritableState;
  _write(chunk: any, encoding: string, callback: Callback): void;
  _writev: ((chunks: { chunk: any; encoding: string }[], callback: Callback) => void) | null;
  _final: ((callback: Callback) => void) | null;
  _destroy(error: Error | null, callback: Callback): void;
  destroy(error?: Error | null, callback?: Callback): this;
}
function writableWrite(stream: WritableLike, chunk: any, encoding: string | Callback | undefined | null, cb: Callback | undefined): boolean {
  const state = stream._writableState;
  if (typeof encoding === "function") { cb = encoding; encoding = state.defaultEncoding; }
  else {
    if (!encoding) encoding = state.defaultEncoding;
    else if (encoding !== "buffer" && !Buffer.isEncoding(encoding)) throw errUnknownEncoding(encoding);
    if (typeof cb !== "function") cb = nop;
  }
  if (chunk === null) throw errStreamNullValues();
  if (!state.objectMode) {
    if (typeof chunk === "string") {
      if (state.decodeStrings !== false) { chunk = Buffer.from(chunk, encoding); encoding = "buffer"; }
    } else if (chunk instanceof Buffer) encoding = "buffer";
    else if (isUint8Array(chunk)) { chunk = asBuffer(chunk); encoding = "buffer"; }
    else throw errInvalidChunk(chunk);
  }
  let err: Error | undefined;
  if (state.ending) err = errStreamWriteAfterEnd();
  else if (state.destroyed) err = errStreamDestroyed("write");
  if (err) {
    const callback = cb;
    nextTick(() => callback(err));
    errorOrDestroy(stream, err, true);
    return false;
  }
  state.pendingcb++;
  return writeOrBuffer(stream, state, chunk, encoding, cb);
}
function writeOrBuffer(stream: WritableLike, state: WritableState, chunk: any, encoding: string, callback: Callback): boolean {
  const len = state.objectMode ? 1 : (chunk as Buffer | string).length;
  state.length += len;
  const ret = state.length < state.highWaterMark;
  if (!ret) state.needDrain = true;
  if (state.writing || state.corked || state.errored !== null || !state.constructed) {
    state.buffered.push({ chunk, encoding, callback });
    if (state.allBuffers && encoding !== "buffer") state.allBuffers = false;
    if (state.allNoop && callback !== nop) state.allNoop = false;
  } else {
    state.writelen = len;
    state.writecb = callback;
    state.writing = true;
    state.sync = true;
    stream._write(chunk, encoding, (er) => onwrite(stream, er));
    state.sync = false;
  }
  return ret && state.errored === null && !state.destroyed;
}
function doWrite(stream: WritableLike, state: WritableState, writev: boolean, len: number, chunk: any, encoding: string, cb: Callback): void {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (state.destroyed) onwrite(stream, errStreamDestroyed("write"));
  else if (writev && stream._writev !== null) stream._writev(chunk, (er) => onwrite(stream, er));
  else stream._write(chunk, encoding, (er) => onwrite(stream, er));
  state.sync = false;
}
function onwrite(stream: WritableLike, er: Error | null | undefined): void {
  const state = stream._writableState;
  const sync = state.sync;
  const cb = state.writecb;
  if (typeof cb !== "function") { errorOrDestroy(stream, errMultipleCallback()); return; }
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
  if (er) {
    if (state.errored === null) state.errored = er;
    const r = stream._readableState;
    if (r !== undefined && r.errored === null) r.errored = er;
    if (sync) nextTick(() => onwriteError(stream, state, er, cb));
    else onwriteError(stream, state, er, cb);
  } else {
    if (state.buffered.length > state.bufferedIndex) clearBuffer(stream, state);
    if (sync) {
      if (state.afterWriteTickInfo !== null && state.afterWriteTickInfo.cb === cb) state.afterWriteTickInfo.count++;
      else {
        const info = { count: 1, cb };
        state.afterWriteTickInfo = info;
        nextTick(() => { state.afterWriteTickInfo = null; afterWrite(stream, state, info.count, info.cb); });
      }
    } else afterWrite(stream, state, 1, cb);
  }
}
function onwriteError(stream: WritableLike, state: WritableState, er: Error, cb: Callback): void {
  --state.pendingcb;
  cb(er);
  errorBuffer(state);
  errorOrDestroy(stream, er);
}
function afterWrite(stream: WritableLike, state: WritableState, count: number, cb: Callback): void {
  const needDrain = !state.ending && !state.destroyed && state.length === 0 && state.needDrain;
  if (needDrain) {
    state.needDrain = false;
    stream.emit("drain");
  }
  while (count-- > 0) {
    state.pendingcb--;
    cb(null);
  }
  if (state.destroyed) errorBuffer(state);
  finishMaybe(stream, state, false);
}
function errorBuffer(state: WritableState): void {
  if (state.writing) return;
  for (let n = state.bufferedIndex; n < state.buffered.length; ++n) {
    const { chunk, callback } = state.buffered[n];
    const len = state.objectMode ? 1 : (chunk as Buffer | string).length;
    state.length -= len;
    callback(state.errored !== null ? state.errored : errStreamDestroyed("write"));
  }
  const onfinished = state.onFinished.splice(0);
  for (const callback of onfinished) callback(state.errored !== null ? state.errored : errStreamDestroyed("end"));
  resetBuffer(state);
}
function resetBuffer(state: WritableState): void {
  state.buffered = [];
  state.bufferedIndex = 0;
  state.allBuffers = true;
  state.allNoop = true;
}
function clearBuffer(stream: WritableLike, state: WritableState): void {
  if (state.corked || state.bufferProcessing || state.destroyed || !state.constructed) return;
  const buffered = state.buffered;
  const objectMode = state.objectMode;
  const bufferedLength = buffered.length - state.bufferedIndex;
  if (!bufferedLength) return;
  let i = state.bufferedIndex;
  state.bufferProcessing = true;
  if (bufferedLength > 1 && stream._writev !== null) {
    state.pendingcb -= bufferedLength - 1;
    const callback: Callback = state.allNoop ? nop : (err) => { for (let n = i; n < buffered.length; ++n) buffered[n].callback(err); };
    const chunks = state.allNoop && i === 0 ? buffered : buffered.slice(i);
    doWrite(stream, state, true, state.length, chunks, "", callback);
    resetBuffer(state);
  } else {
    do {
      const { chunk, encoding, callback } = buffered[i];
      i++;
      const len = objectMode ? 1 : (chunk as Buffer | string).length;
      doWrite(stream, state, false, len, chunk, encoding, callback);
    } while (i < buffered.length && !state.writing);
    if (i === buffered.length) resetBuffer(state);
    else if (i > 256) { buffered.splice(0, i); state.bufferedIndex = 0; }
    else state.bufferedIndex = i;
  }
  state.bufferProcessing = false;
}
function writableEnd(stream: WritableLike, chunk?: any, encoding?: string | Callback | null, cb?: Callback): void {
  const state = stream._writableState;
  if (typeof chunk === "function") { cb = chunk; chunk = null; encoding = null; }
  else if (typeof encoding === "function") { cb = encoding; encoding = null; }
  let err: Error | undefined;
  if (chunk !== null && chunk !== undefined) {
    try { writableWrite(stream, chunk, encoding, undefined); } catch (e) { err = e as Error; }
  }
  if (state.corked) { state.corked = 1; writableUncork(stream); }
  if (err) { /* the write reported it */ }
  else if (state.errored === null && !state.ending) {
    state.ending = true;
    finishMaybe(stream, state, true);
    state.ended = true;
  } else if (state.finished) err = errStreamAlreadyFinished("end");
  else if (state.destroyed) err = errStreamDestroyed("end");
  if (typeof cb === "function") {
    const callback = cb;
    if (err || state.finished) nextTick(() => callback(err));
    else state.onFinished.push(callback);
  }
}
function writableUncork(stream: WritableLike): void {
  const state = stream._writableState;
  if (state.corked) {
    state.corked--;
    if (!state.writing) clearBuffer(stream, state);
  }
}
function needFinish(state: WritableState): boolean {
  return state.ending && !state.destroyed && state.constructed && state.length === 0 && state.errored === null &&
    state.buffered.length === 0 && !state.finished && !state.writing && !state.errorEmitted && !state.closeEmitted;
}
function callFinal(stream: WritableLike, state: WritableState): void {
  let called = false;
  function onFinish(err?: Error | null): void {
    if (called) { errorOrDestroy(stream, errMultipleCallback()); return; }
    called = true;
    state.pendingcb--;
    if (err) {
      const onfinished = state.onFinished.splice(0);
      for (const callback of onfinished) callback(err);
      errorOrDestroy(stream, err, state.sync);
    } else if (needFinish(state)) {
      state.prefinished = true;
      stream.emit("prefinish");
      state.pendingcb++;
      nextTick(() => finish(stream, state));
    }
  }
  state.sync = true;
  state.pendingcb++;
  try { (stream._final as (callback: Callback) => void)(onFinish); } catch (err) { onFinish(err as Error); }
  state.sync = false;
}
function prefinish(stream: WritableLike, state: WritableState): void {
  if (!state.prefinished && !state.finalCalled) {
    if (stream._final !== null && !state.destroyed) {
      state.finalCalled = true;
      callFinal(stream, state);
    } else {
      state.prefinished = true;
      stream.emit("prefinish");
    }
  }
}
function finishMaybe(stream: WritableLike, state: WritableState, sync: boolean): void {
  if (needFinish(state)) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      if (sync) {
        state.pendingcb++;
        nextTick(() => {
          if (needFinish(state)) finish(stream, state);
          else state.pendingcb--;
        });
      } else if (needFinish(state)) {
        state.pendingcb++;
        finish(stream, state);
      }
    }
  }
}
function finish(stream: WritableLike, state: WritableState): void {
  state.pendingcb--;
  state.finished = true;
  const onfinished = state.onFinished.splice(0);
  for (const callback of onfinished) callback(null);
  stream.emit("finish");
  if (state.autoDestroy) {
    const r = stream._readableState;
    const autoDestroy = r === undefined || (r.autoDestroy && (r.endEmitted || r.readable === false));
    if (autoDestroy) destroyStream(stream, null, undefined);
  }
}

export class Writable extends Stream {
  _writableState: WritableState;
  _writev: ((chunks: { chunk: any; encoding: string }[], callback: Callback) => void) | null = null;
  _final: ((callback: Callback) => void) | null = null;
  private writeImpl: ((this: Writable, chunk: any, encoding: string, callback: Callback) => void) | undefined;
  private destroyImpl: ((this: Stream, error: Error | null, callback: Callback) => void) | undefined;
  constructor(options?: WritableOptions) {
    super(options);
    this._writableState = new WritableState(options, false);
    if (options) {
      if (typeof options.write === "function") this.writeImpl = options.write;
      if (typeof options.writev === "function") this._writev = options.writev.bind(this);
      if (typeof options.final === "function") this._final = options.final.bind(this);
      if (typeof options.destroy === "function") this.destroyImpl = options.destroy;
      if (typeof options.construct === "function") constructStream(this, options.construct);
    }
  }
  _write(chunk: any, encoding: string, callback: Callback): void {
    if (this.writeImpl !== undefined) { this.writeImpl.call(this, chunk, encoding, callback); return; }
    if (this._writev !== null) { this._writev([{ chunk, encoding }], callback); return; }
    throw errMethodNotImplemented("_write()");
  }
  _destroy(error: Error | null, callback: Callback): void {
    if (this.destroyImpl !== undefined) { this.destroyImpl.call(this, error, callback); return; }
    callback(error);
  }
  write(chunk: any, encoding?: string | Callback | null, callback?: Callback): boolean { return writableWrite(this, chunk, encoding, callback); }
  end(chunk?: any, encoding?: string | Callback | null, callback?: Callback): this { writableEnd(this, chunk, encoding, callback); return this; }
  cork(): void { this._writableState.corked++; }
  uncork(): void { writableUncork(this); }
  setDefaultEncoding(encoding: string): this {
    if (typeof encoding === "string") encoding = encoding.toLowerCase();
    if (!Buffer.isEncoding(encoding)) throw errUnknownEncoding(encoding);
    this._writableState.defaultEncoding = encoding;
    return this;
  }
  destroy(error?: Error | null, callback?: Callback): this {
    destroyStream(this, error === undefined ? null : error, callback);
    return this;
  }
  get writable(): boolean {
    const w = this._writableState;
    return w.writable !== false && !w.destroyed && w.errored === null && !w.ending && !w.ended;
  }
  set writable(value: boolean) { this._writableState.writable = !!value; }
  get writableEnded(): boolean { return this._writableState.ending; }
  get writableFinished(): boolean { return this._writableState.finished; }
  get writableLength(): number { return this._writableState.length; }
  get writableHighWaterMark(): number { return this._writableState.highWaterMark; }
  get writableObjectMode(): boolean { return this._writableState.objectMode; }
  get writableCorked(): number { return this._writableState.corked; }
  get writableNeedDrain(): boolean { const w = this._writableState; return !w.destroyed && !w.ending && w.needDrain; }
  get writableAborted(): boolean {
    const w = this._writableState;
    return w.writable !== false && (w.destroyed || w.errored !== null) && !w.finished;
  }
  get destroyed(): boolean { return this._writableState.destroyed; }
  set destroyed(value: boolean) { this._writableState.destroyed = value; }
  get errored(): Error | null { return this._writableState.errored; }
  get closed(): boolean { return this._writableState.closed; }
}

// ======================= Duplex =======================
export class Duplex extends Readable {
  _writableState: WritableState;
  _writev: ((chunks: { chunk: any; encoding: string }[], callback: Callback) => void) | null = null;
  _final: ((callback: Callback) => void) | null = null;
  private writeImpl: ((this: Writable, chunk: any, encoding: string, callback: Callback) => void) | undefined;
  constructor(options?: DuplexOptions) {
    super(options);
    this._writableState = new WritableState(options, true);
    if (options) {
      if (typeof options.write === "function") this.writeImpl = options.write;
      if (typeof options.writev === "function") this._writev = options.writev.bind(this as unknown as Writable);
      if (typeof options.final === "function") this._final = options.final.bind(this as unknown as Writable);
      if (options.allowHalfOpen === false) this.allowHalfOpen = false;
      if (options.readable === false) { this._readableState.readable = false; this._readableState.ended = true; this._readableState.endEmitted = true; }
      if (options.writable === false) { this._writableState.writable = false; this._writableState.ending = true; this._writableState.ended = true; this._writableState.finished = true; }
      if (typeof options.construct === "function") constructStream(this, options.construct);
    }
  }
  _write(chunk: any, encoding: string, callback: Callback): void {
    if (this.writeImpl !== undefined) { this.writeImpl.call(this as unknown as Writable, chunk, encoding, callback); return; }
    if (this._writev !== null) { this._writev([{ chunk, encoding }], callback); return; }
    throw errMethodNotImplemented("_write()");
  }
  write(chunk: any, encoding?: string | Callback | null, callback?: Callback): boolean { return writableWrite(this as unknown as WritableLike, chunk, encoding, callback); }
  end(chunk?: any, encoding?: string | Callback | null, callback?: Callback): this { writableEnd(this as unknown as WritableLike, chunk, encoding, callback); return this; }
  cork(): void { this._writableState.corked++; }
  uncork(): void { writableUncork(this as unknown as WritableLike); }
  setDefaultEncoding(encoding: string): this {
    if (!Buffer.isEncoding(encoding)) throw errUnknownEncoding(encoding);
    this._writableState.defaultEncoding = encoding;
    return this;
  }
  get writable(): boolean {
    const w = this._writableState;
    return w.writable !== false && !w.destroyed && w.errored === null && !w.ending && !w.ended;
  }
  set writable(value: boolean) { this._writableState.writable = !!value; }
  get writableEnded(): boolean { return this._writableState.ending; }
  get writableFinished(): boolean { return this._writableState.finished; }
  get writableLength(): number { return this._writableState.length; }
  get writableHighWaterMark(): number { return this._writableState.highWaterMark; }
  get writableObjectMode(): boolean { return this._writableState.objectMode; }
  get writableCorked(): number { return this._writableState.corked; }
  get writableNeedDrain(): boolean { const w = this._writableState; return !w.destroyed && !w.ending && w.needDrain; }
  get destroyed(): boolean { return this._readableState.destroyed || this._writableState.destroyed; }
  set destroyed(value: boolean) { this._readableState.destroyed = value; this._writableState.destroyed = value; }
  get errored(): Error | null { return this._writableState.errored !== null ? this._writableState.errored : this._readableState.errored; }
  get closed(): boolean { return this._writableState.closed && this._readableState.closed; }
}

// ======================= Transform / PassThrough =======================
export class Transform extends Duplex {
  private transformImpl: ((this: Transform, chunk: any, encoding: string, callback: (error?: Error | null, data?: any) => void) => void) | undefined;
  private flushImpl: ((this: Transform, callback: (error?: Error | null, data?: any) => void) => void) | undefined;
  private pendingCallback: Callback | null = null;
  constructor(options?: TransformOptions) {
    super(options);
    this._readableState.sync = false;
    if (options) {
      if (typeof options.transform === "function") this.transformImpl = options.transform;
      if (typeof options.flush === "function") this.flushImpl = options.flush;
    }
    this._final = (callback: Callback): void => { this.transformFinal(callback); };
  }
  private transformFinal(callback: Callback | null): void {
    if (!this._writableState.destroyed) {
      this._flush((er, data) => {
        if (er) {
          if (callback) callback(er);
          else this.destroy(er);
          return;
        }
        if (data !== null && data !== undefined) this.push(data);
        this.push(null);
        if (callback) callback();
      });
    } else {
      this.push(null);
      if (callback) callback();
    }
  }
  _transform(chunk: any, encoding: string, callback: (error?: Error | null, data?: any) => void): void {
    if (this.transformImpl !== undefined) { this.transformImpl.call(this, chunk, encoding, callback); return; }
    throw errMethodNotImplemented("_transform()");
  }
  _flush(callback: (error?: Error | null, data?: any) => void): void {
    if (this.flushImpl !== undefined) { this.flushImpl.call(this, callback); return; }
    callback();
  }
  _write(chunk: any, encoding: string, callback: Callback): void {
    const rState = this._readableState;
    const wState = this._writableState;
    const length = rState.length;
    this._transform(chunk, encoding, (err, val) => {
      if (err) { callback(err); return; }
      if (val !== null && val !== undefined) this.push(val);
      if (wState.ended || length === rState.length || rState.length < rState.highWaterMark) callback();
      else this.pendingCallback = callback;
    });
  }
  _read(_size: number): void {
    if (this.pendingCallback !== null) {
      const callback = this.pendingCallback;
      this.pendingCallback = null;
      callback();
    }
  }
}
export class PassThrough extends Transform {
  _transform(chunk: any, _encoding: string, callback: (error?: Error | null, data?: any) => void): void { callback(null, chunk); }
}

// ======================= construct =======================
/** The construct protocol: the stream is not constructed until the option's
 *  callback (writes buffer, reads wait); then the buffered writes run and a
 *  waiting read is served, or a failure destroys the stream. */
function constructStream(stream: Stream, construct: (this: Stream, callback: Callback) => void): void {
  const r = stream._readableState;
  const w = stream._writableState;
  if (r !== undefined) r.constructed = false;
  if (w !== undefined) w.constructed = false;
  let called = false;
  const onConstruct = (err?: Error | null): void => {
    if (called) { errorOrDestroy(stream, errMultipleCallback()); return; }
    called = true;
    if (r !== undefined) r.constructed = true;
    if (w !== undefined) w.constructed = true;
    const pending = stream.pendingDestroy;
    if (pending !== null) {
      stream.pendingDestroy = null;
      if (r !== undefined) r.destroyed = false;
      if (w !== undefined) w.destroyed = false;
      destroyStream(stream, pending.error || err || null, pending.callback);
      return;
    }
    if (err) { destroyStream(stream, err, undefined); return; }
    nextTick(() => {
      if (w !== undefined && !w.destroyed) {
        if (!w.writing) clearBuffer(stream as unknown as WritableLike, w);
        finishMaybe(stream as unknown as WritableLike, w, false);
      }
      if (r !== undefined && !r.destroyed && r.needReadable) maybeReadMore(stream as Readable, r);
    });
  };
  nextTick(() => {
    try { construct.call(stream, (err) => nextTick(() => onConstruct(err))); } catch (e) { nextTick(() => onConstruct(e as Error)); }
  });
}

// ======================= destroy =======================
function checkError(err: Error | null | undefined, w: WritableState | undefined, r: ReadableState | undefined): void {
  if (err) {
    if (w !== undefined && w.errored === null) w.errored = err;
    if (r !== undefined && r.errored === null) r.errored = err;
  }
}
function destroyStream(stream: Stream, err: Error | null, cb: Callback | undefined): void {
  const r = stream._readableState;
  const w = stream._writableState;
  if ((w !== undefined && w.destroyed) || (r !== undefined && r.destroyed)) {
    if (typeof cb === "function") cb();
    return;
  }
  checkError(err, w, r);
  if (w !== undefined) w.destroyed = true;
  if (r !== undefined) r.destroyed = true;
  if ((w !== undefined && !w.constructed) || (r !== undefined && !r.constructed)) {
    stream.pendingDestroy = { error: err, callback: cb };
    return;
  }
  let called = false;
  const onDestroy = (err2?: Error | null): void => {
    if (called) return;
    called = true;
    checkError(err2, w, r);
    if (w !== undefined) w.closed = true;
    if (r !== undefined) r.closed = true;
    if (typeof cb === "function") cb(err2);
    if (err2) nextTick(() => { emitErrorNT(stream, err2); emitCloseNT(stream); });
    else nextTick(() => emitCloseNT(stream));
  };
  try {
    (stream as unknown as { _destroy: (error: Error | null, callback: Callback) => void })._destroy(err || null, onDestroy);
  } catch (e) {
    onDestroy(e as Error);
  }
}
function emitCloseNT(stream: Stream): void {
  const r = stream._readableState;
  const w = stream._writableState;
  if (w !== undefined) w.closeEmitted = true;
  if (r !== undefined) r.closeEmitted = true;
  if ((w !== undefined && w.emitClose) || (r !== undefined && r.emitClose)) stream.emit("close");
}
function emitErrorNT(stream: Stream, err: Error): void {
  const r = stream._readableState;
  const w = stream._writableState;
  if ((w !== undefined && w.errorEmitted) || (r !== undefined && r.errorEmitted)) return;
  if (w !== undefined) w.errorEmitted = true;
  if (r !== undefined) r.errorEmitted = true;
  stream.emit("error", err);
}
function errorOrDestroy(stream: Stream, err: Error, sync: boolean = false): void {
  const r = stream._readableState;
  const w = stream._writableState;
  if ((w !== undefined && w.destroyed) || (r !== undefined && r.destroyed)) return;
  if ((r !== undefined && r.autoDestroy) || (w !== undefined && w.autoDestroy)) destroyStream(stream, err, undefined);
  else if (err) {
    if (w !== undefined && w.errored === null) w.errored = err;
    if (r !== undefined && r.errored === null) r.errored = err;
    if (sync) nextTick(() => emitErrorNT(stream, err));
    else emitErrorNT(stream, err);
  }
}
/** destroyer: destroy a stream once (pipeline's cleanup). */
function destroyer(stream: Stream, err: Error | null): void {
  if (isDestroyed(stream)) return;
  destroyStream(stream, err, undefined);
}

// ======================= helpers =======================
export function isReadableNodeStream(obj: unknown): obj is Readable {
  if (obj instanceof Readable) return true;
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as { [key: string]: unknown };
  return typeof o.pipe === "function" && typeof o.on === "function" && o._readableState !== undefined;
}
export function isWritableNodeStream(obj: unknown): obj is Sink {
  if (obj instanceof Writable || obj instanceof Duplex) return true;
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as { [key: string]: unknown };
  return typeof o.write === "function" && typeof o.on === "function" && o._writableState !== undefined;
}
/** stream.readable / stream.writable as Node reads them: undefined on a stream without that half. */
function readableFlag(stream: Stream): boolean | undefined {
  const r = stream._readableState;
  if (r === undefined) return undefined;
  return r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
}
function writableFlag(stream: Stream): boolean | undefined {
  const w = stream._writableState;
  if (w === undefined) return undefined;
  return w.writable !== false && !w.destroyed && w.errored === null && !w.ending && !w.ended;
}
export function isNodeStream(obj: unknown): obj is Stream { return isReadableNodeStream(obj) || isWritableNodeStream(obj); }
function isDestroyed(stream: Stream): boolean {
  const r = stream._readableState, w = stream._writableState;
  return !!((r !== undefined && r.destroyed) || (w !== undefined && w.destroyed));
}
export function isDisturbed(stream: Readable): boolean { const r = stream._readableState; return !!(r && (r.dataEmitted || r.endEmitted || r.errorEmitted || r.closeEmitted)); }
export function isErrored(stream: Stream): boolean {
  const r = stream._readableState, w = stream._writableState;
  return !!((r !== undefined && r.errored !== null) || (w !== undefined && w.errored !== null));
}
export function isReadable(stream: Stream): boolean | null {
  const r = stream._readableState;
  if (r === undefined) return null;
  return r.readable !== false && !r.destroyed && !r.errorEmitted && !r.endEmitted;
}
export function isWritable(stream: Stream): boolean | null {
  const w = stream._writableState;
  if (w === undefined) return null;
  return w.writable !== false && !w.destroyed && w.errored === null && !w.ending && !w.ended;
}
function isWritableFinished(stream: Stream, strict: boolean): boolean | null {
  const w = stream._writableState;
  if (w === undefined) return null;
  if (w.errored !== null) return false;
  return !!(w.finished || (strict === false && w.ended === true && w.length === 0));
}
function isReadableFinished(stream: Stream, strict: boolean): boolean | null {
  const r = stream._readableState;
  if (r === undefined) return null;
  if (r.errored !== null) return false;
  return !!(r.endEmitted || (strict === false && r.ended === true && r.length === 0));
}
function willEmitClose(stream: Stream): boolean {
  const r = stream._readableState, w = stream._writableState;
  return !!((r !== undefined && r.autoDestroy && r.emitClose && r.closed === false) || (w !== undefined && w.autoDestroy && w.emitClose && w.closed === false));
}

export interface FinishedOptions { error?: boolean; readable?: boolean; writable?: boolean; cleanup?: boolean }
/** finished(stream, [options], callback): the callback when the stream is done
 *  (end and/or finish, an error, or a close before either: ERR_STREAM_PREMATURE_CLOSE).
 *  Returns a function that detaches the listeners. */
export function finished(stream: Stream, options: FinishedOptions | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): () => void {
  let opts: FinishedOptions;
  if (typeof options === "function") { callback = options; opts = {}; }
  else opts = options || {};
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
  let cb: ((error?: Error | null) => void) = callback;
  let done = false;
  const call = (err?: Error | null): void => { if (done) return; done = true; cb.call(stream, err); };
  const readable = opts.readable !== undefined ? opts.readable : isReadableNodeStream(stream);
  const writable = opts.writable !== undefined ? opts.writable : isWritableNodeStream(stream);
  const wState = stream._writableState;
  const rState = stream._readableState;
  let willClose = willEmitClose(stream);
  let writableFinished = isWritableFinished(stream, false) === true;
  const onfinish = (): void => {
    writableFinished = true;
    if (isDestroyed(stream)) willClose = false;
    if (willClose && (!readableFlag(stream) || readable)) return;
    if (!readable || readableFinished) call();
  };
  let readableFinished = isReadableFinished(stream, false) === true;
  const onend = (): void => {
    readableFinished = true;
    if (isDestroyed(stream)) willClose = false;
    if (willClose && (!writableFlag(stream) || writable)) return;
    if (!writable || writableFinished) call();
  };
  const onerror = (err: Error): void => { call(err); };
  const onclose = (): void => {
    const errored = (wState !== undefined && wState.errored) || (rState !== undefined && rState.errored) || null;
    if (errored !== null) { call(errored); return; }
    if (readable && !readableFinished && isReadableNodeStream(stream)) {
      if (!isReadableFinished(stream, false)) { call(errPrematureClose()); return; }
    }
    if (writable && !writableFinished) {
      if (!isWritableFinished(stream, false)) { call(errPrematureClose()); return; }
    }
    call();
  };
  stream.on("end", onend);
  stream.on("finish", onfinish);
  if (opts.error !== false) stream.on("error", onerror);
  stream.on("close", onclose);
  const closed = !!((wState !== undefined && wState.closed) || (rState !== undefined && rState.closed));
  if (closed) nextTick(onclose);
  else if ((wState !== undefined && wState.errorEmitted) || (rState !== undefined && rState.errorEmitted)) {
    if (!willClose) nextTick(onclose);
  } else if (!readable && (!willClose || isReadable(stream)) && (writableFinished || isWritable(stream) === false)) nextTick(onclose);
  else if (!writable && (!willClose || isWritable(stream)) && (readableFinished || isReadable(stream) === false)) nextTick(onclose);
  const cleanup = (): void => {
    cb = nop;
    stream.removeListener("end", onend);
    stream.removeListener("finish", onfinish);
    stream.removeListener("error", onerror);
    stream.removeListener("close", onclose);
  };
  if (opts.cleanup) stream.once("close", () => nextTick(cleanup));
  return cleanup;
}

type PipelineSource = Stream | Iterable<any> | AsyncIterable<any> | ((...args: any[]) => any);
/** pipeline(source, ...transforms, destination, callback): pipes the streams,
 *  destroys all of them when one fails or closes early, and calls back once.
 *  A function in the chain receives the previous stage as an async iterable and
 *  returns one (or, as the last stage, a promise). */
export type PipelineCallback = (error?: Error | null, value?: any) => void;
export type PipelineStage = Stream | Iterable<any> | AsyncIterable<any> | ((source: any) => any);
export function pipeline(...args: [...stages: PipelineStage[], callback: PipelineCallback]): Stream;
export function pipeline(stages: PipelineStage[], callback: PipelineCallback): Stream;
export function pipeline(...args: any[]): Stream {
  let callback: ((error?: Error | null, value?: any) => void) = nop;
  if (args.length > 0 && typeof args[args.length - 1] === "function" && !isNodeStream(args[args.length - 1]) && args.length > 1) {
    // the last function argument is the callback only when the stage before it is a destination
    const last = args[args.length - 1] as AnyFunction;
    if (last.length <= 2 && !isGeneratorLike(last)) callback = args.pop();
  }
  let streams: PipelineSource[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (streams.length < 2) throw errMissingArgs("streams");
  let error: Error | null | undefined;
  let value: any;
  let finishCount = 0;
  let calledBack = false;
  const destroys: ((err: Error | null) => void)[] = [];
  const finishImpl = (err: Error | null | undefined, final: boolean): void => {
    if (err && (!error || (error as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE")) error = err;
    if (!error && !final) return;
    while (destroys.length) { const d = destroys.shift(); if (d) d(error || null); }
    if (final && !calledBack) { calledBack = true; nextTick(() => callback(error || null, value)); }
  };
  const finish = (err?: Error | null): void => finishImpl(err, --finishCount === 0);
  let ret: any;
  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    const reading = i < streams.length - 1;
    const writing = i > 0;
    const isLastStream = i === streams.length - 1;
    if (isNodeStream(stream)) {
      finishCount++;
      destroys.push(pipelineDestroyer(stream, reading, writing, finish));
    }
    if (i === 0) {
      if (typeof stream === "function") {
        ret = (stream as AnyFunction)();
        if (!isIterable(ret)) throw errInvalidReturnValue("Iterable, AsyncIterable or Stream", "source", ret);
      } else if (isIterable(stream) || isReadableNodeStream(stream)) ret = stream;
      else throw invalidArgType("source", "of type Readable, Iterable, AsyncIterable or Function", stream);
    } else if (typeof stream === "function") {
      ret = makeAsyncIterable(ret);
      ret = (stream as AnyFunction)(ret);
      if (reading) {
        if (!isIterable(ret)) throw errInvalidReturnValue("AsyncIterable", `transform[${i - 1}]`, ret);
      } else {
        const pt = new PassThrough({ objectMode: true });
        if (ret !== null && typeof ret === "object" && typeof ret.then === "function") {
          finishCount++;
          (ret as Promise<any>).then((val) => {
            value = val;
            if (val !== null && val !== undefined) pt.write(val);
            pt.end();
            nextTick(finish);
          }, (err) => {
            pt.destroy(err);
            nextTick(() => finish(err));
          });
        } else if (isIterable(ret)) {
          finishCount++;
          pumpToNode(ret, pt, finish, true);
        } else throw errInvalidReturnValue("AsyncIterable or Promise", "destination", ret);
        ret = pt;
        finishCount++;
        destroys.push(pipelineDestroyer(pt, false, true, finish));
      }
    } else if (isNodeStream(stream)) {
      if (isReadableNodeStream(ret)) {
        finishCount += 2;
        pipelinePipe(ret, stream as Sink, finish, true);
      } else if (isIterable(ret)) {
        finishCount++;
        pumpToNode(ret, stream as Sink, finish, true);
      } else throw invalidArgType("val", "of type Readable, Iterable, AsyncIterable or Function", ret);
      ret = stream;
    } else throw invalidArgType(isLastStream ? "destination" : `transform[${i - 1}]`, "of type Stream or Function", stream);
  }
  return ret as Stream;
}
function isGeneratorLike(fn: AnyFunction): boolean {
  const name = (fn as { constructor?: { name?: string } }).constructor && (fn as { constructor?: { name?: string } }).constructor!.name;
  return name === "AsyncGeneratorFunction" || name === "GeneratorFunction";
}
function isIterable(obj: unknown): boolean {
  return obj !== null && typeof obj === "object" &&
    (typeof (obj as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function" || typeof (obj as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function");
}
function makeAsyncIterable(val: unknown): AsyncIterable<any> {
  if (isReadableNodeStream(val)) return val;
  if (isIterable(val)) return val as AsyncIterable<any>;
  throw invalidArgType("val", "of type Readable, Iterable or AsyncIterable", val);
}
function pipelineDestroyer(stream: Stream, reading: boolean, writing: boolean, callback: (err?: Error | null) => void): (err: Error | null) => void {
  let finishedFlag = false;
  stream.on("close", () => { finishedFlag = true; });
  finished(stream, { readable: reading, writable: writing }, (err) => {
    finishedFlag = !err;
    callback(err);
  });
  return (err: Error | null): void => {
    if (finishedFlag) return;
    finishedFlag = true;
    destroyer(stream, err || errStreamDestroyed("pipe"));
  };
}
function pipelinePipe(src: Readable, dst: Sink, finish: (err?: Error | null) => void, end: boolean): void {
  let ended = false;
  dst.on("close", () => { if (!ended) finish(errPrematureClose()); });
  src.pipe(dst, { end: false });
  if (end) {
    const endFn = (): void => { ended = true; dst.end(); };
    if (isReadableFinished(src, false)) nextTick(endFn);
    else src.once("end", endFn);
  } else finish();
  finished(src, { readable: true, writable: false }, (err) => {
    const rState = src._readableState;
    if (err && (err as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE" && rState && rState.ended && rState.errored === null && !rState.errorEmitted) {
      src.once("end", finish).once("error", finish);
    } else finish(err);
  });
  finished(dst, { readable: false, writable: true }, finish);
}
async function pumpToNode(iterable: AsyncIterable<any> | Iterable<any>, writable: Sink, finish: (err?: Error | null) => void, end: boolean): Promise<void> {
  let error: Error | undefined;
  let onresolve: (() => void) | null = null;
  const resume = (err?: Error | null): void => {
    if (err) error = err;
    if (onresolve !== null) { const cb = onresolve; onresolve = null; cb(); }
  };
  const wait = (): Promise<void> => new Promise<void>((resolve, reject) => {
    if (error) reject(error);
    else onresolve = (): void => { if (error) reject(error); else resolve(); };
  });
  writable.on("drain", resume);
  const cleanup = finished(writable, { readable: false }, resume);
  try {
    if (writable.writableNeedDrain) await wait();
    if (typeof (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
      for await (const chunk of iterable as AsyncIterable<any>) { if (!writable.write(chunk)) await wait(); }
    } else {
      for (const chunk of iterable as Iterable<any>) { if (!writable.write(chunk)) await wait(); }
    }
    if (end) { writable.end(); await wait(); }
    finish();
  } catch (err) {
    finish(error !== undefined && error !== err ? error : (err as Error));
  } finally {
    cleanup();
    writable.off("drain", resume);
  }
}
/** addAbortSignal(signal, stream): destroys the stream with an AbortError when the signal aborts. */
export function addAbortSignal<T extends Stream>(signal: { aborted: boolean; addEventListener: (type: string, listener: () => void, options?: unknown) => void }, stream: T): T {
  const onAbort = (): void => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    (err as { code?: string }).code = "ABORT_ERR";
    destroyStream(stream, err, undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return stream;
}

const stream = { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, addAbortSignal, isReadable, isWritable, isErrored, isDisturbed };
export default stream;
