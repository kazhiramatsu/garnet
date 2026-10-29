// WHATWG Streams (docs/web_streams_design.md): ReadableStream with default readers, WritableStream,
// TransformStream, TextEncoderStream / TextDecoderStream and the two queuing strategies, in
// TypeScript over promises: what hono's streaming helpers, body-limit, etag and the JSX streaming
// renderer use, and what a Request or Response body is when it streams (lib/node/web/fetch.ts).
// Byte streams (`type: "bytes"`, BYOB readers) are not provided. The prelude installs the classes as
// the globals when the program names them; under the V8 oracle they are Node's own, whose
// behaviour and error messages these follow.

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void; settled: boolean }
function deferred<T>(): Deferred<T> {
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = (v) => { d.settled = true; resolve(v); };
    d.reject = (e) => { d.settled = true; reject(e); };
  });
  return d;
}
/** A promise nobody may await (a reader's `closed`, a writer's `ready`): its rejection is not unhandled. */
function handled<T>(p: Promise<T>): Promise<T> { p.catch(() => undefined); return p; }
const invalidState = (what: string): TypeError => new TypeError(`Invalid state: ${what}`);

export interface QueuingStrategy<T = unknown> { highWaterMark?: number; size?: (chunk: T) => number }
export class CountQueuingStrategy implements QueuingStrategy<unknown> {
  readonly highWaterMark: number;
  constructor(init: { highWaterMark: number }) { this.highWaterMark = init.highWaterMark; }
  size(): number { return 1; }
}
export class ByteLengthQueuingStrategy implements QueuingStrategy<ArrayBufferView> {
  readonly highWaterMark: number;
  constructor(init: { highWaterMark: number }) { this.highWaterMark = init.highWaterMark; }
  size(chunk: ArrayBufferView): number { return chunk.byteLength; }
}
function highWaterMarkOf<T>(strategy: QueuingStrategy<T> | undefined, fallback: number): number {
  if (strategy === undefined || strategy.highWaterMark === undefined) return fallback;
  const n = Number(strategy.highWaterMark);
  if (Number.isNaN(n) || n < 0) throw new RangeError("Invalid highWaterMark");
  return n;
}
function sizeAlgorithmOf<T>(strategy: QueuingStrategy<T> | undefined): (chunk: T) => number {
  if (strategy === undefined || strategy.size === undefined) return () => 1;
  const size = strategy.size;
  return (chunk) => {
    const n = Number(size(chunk));
    if (Number.isNaN(n) || n < 0 || !Number.isFinite(n)) throw new RangeError("The return value of a queuing strategy's size function must be a finite, non-NaN, non-negative number");
    return n;
  };
}

// ---- ReadableStream ----

export interface ReadableStreamReadResult<R> { value: R | undefined; done: boolean }
export interface UnderlyingSource<R = unknown> {
  start?: (controller: ReadableStreamDefaultController<R>) => unknown;
  pull?: (controller: ReadableStreamDefaultController<R>) => unknown;
  cancel?: (reason: unknown) => unknown;
  type?: unknown;
}

export class ReadableStreamDefaultController<R = unknown> {
  #stream: ReadableStream<R>;
  #queue: { chunk: R; size: number }[] = [];
  #queueTotalSize = 0;
  #started = false;
  #pulling = false;
  #pullAgain = false;
  #closeRequested = false;
  readonly #highWaterMark: number;
  readonly #sizeAlgorithm: (chunk: R) => number;
  readonly #pullAlgorithm: (controller: ReadableStreamDefaultController<R>) => unknown;
  readonly #cancelAlgorithm: (reason: unknown) => unknown;
  constructor(stream: ReadableStream<R>, source: UnderlyingSource<R>, highWaterMark: number, size: (chunk: R) => number) {
    this.#stream = stream;
    this.#highWaterMark = highWaterMark;
    this.#sizeAlgorithm = size;
    this.#pullAlgorithm = source.pull === undefined ? () => undefined : (c) => source.pull!.call(source, c);
    this.#cancelAlgorithm = source.cancel === undefined ? () => undefined : (reason) => source.cancel!.call(source, reason);
  }
  /** start the source; its errors error the stream */
  __start(source: UnderlyingSource<R>): void {
    let started: unknown;
    try { started = source.start === undefined ? undefined : source.start.call(source, this); } catch (e) { this.error(e); return; }
    Promise.resolve(started).then(() => { this.#started = true; this.#callPullIfNeeded(); }, (e) => this.error(e));
  }
  get desiredSize(): number | null {
    const state = this.#stream.__state;
    if (state === "errored") return null;
    if (state === "closed") return 0;
    return this.#highWaterMark - this.#queueTotalSize;
  }
  close(): void {
    if (this.#closeRequested || this.#stream.__state !== "readable") throw invalidState("Controller is already closed");
    this.#closeRequested = true;
    if (this.#queue.length === 0) this.#stream.__close();
  }
  enqueue(chunk: R): void {
    if (this.#closeRequested || this.#stream.__state !== "readable") throw invalidState("Controller is already closed");
    const reader = this.#stream.__reader;
    if (reader !== null && reader.__fulfillRead(chunk)) { this.#callPullIfNeeded(); return; }
    let size: number;
    try { size = this.#sizeAlgorithm(chunk); } catch (e) { this.error(e); throw e; }
    this.#queue.push({ chunk, size });
    this.#queueTotalSize += size;
    this.#callPullIfNeeded();
  }
  error(e: unknown): void {
    if (this.#stream.__state !== "readable") return;
    this.#queue = [];
    this.#queueTotalSize = 0;
    this.#stream.__error(e);
  }
  /** a read: the next chunk now, or a request the next enqueue fulfills */
  __pull(reader: ReadableStreamDefaultReader<R>): Promise<ReadableStreamReadResult<R>> {
    if (this.#queue.length > 0) {
      const entry = this.#queue.shift()!;
      this.#queueTotalSize -= entry.size;
      if (this.#closeRequested && this.#queue.length === 0) this.#stream.__close();
      else this.#callPullIfNeeded();
      return Promise.resolve({ value: entry.chunk, done: false });
    }
    const request = reader.__addReadRequest();
    this.#callPullIfNeeded();
    return request;
  }
  __cancel(reason: unknown): Promise<void> {
    this.#queue = [];
    this.#queueTotalSize = 0;
    let result: unknown;
    try { result = this.#cancelAlgorithm(reason); } catch (e) { return Promise.reject(e); }
    return Promise.resolve(result).then(() => undefined);
  }
  #callPullIfNeeded(): void {
    if (!this.#started || this.#closeRequested || this.#stream.__state !== "readable") return;
    const reader = this.#stream.__reader;
    const wanted = (reader !== null && reader.__pendingReads > 0) || (this.desiredSize ?? 0) > 0;
    if (!wanted) return;
    if (this.#pulling) { this.#pullAgain = true; return; }
    this.#pulling = true;
    let pulled: unknown;
    try { pulled = this.#pullAlgorithm(this); } catch (e) { this.#pulling = false; this.error(e); return; }
    Promise.resolve(pulled).then(() => {
      this.#pulling = false;
      if (this.#pullAgain) { this.#pullAgain = false; this.#callPullIfNeeded(); }
    }, (e) => { this.#pulling = false; this.error(e); });
  }
  get [Symbol.toStringTag](): string { return "ReadableStreamDefaultController"; }
}

export class ReadableStreamDefaultReader<R = unknown> {
  #stream: ReadableStream<R> | null;
  #readRequests: Deferred<ReadableStreamReadResult<R>>[] = [];
  readonly #closed: Deferred<void> = deferred<void>();
  constructor(stream: ReadableStream<R>) {
    if (!(stream instanceof ReadableStream)) throw new TypeError("ReadableStreamDefaultReader constructor requires a ReadableStream");
    if (stream.locked) throw invalidState("ReadableStream is locked");
    stream.__materialize();
    this.#stream = stream;
    handled(this.#closed.promise);
    stream.__attachReader(this);
    if (stream.__state === "closed") this.#closed.resolve(undefined);
    else if (stream.__state === "errored") this.#closed.reject(stream.__storedError);
  }
  get closed(): Promise<void> { return this.#closed.promise; }
  read(): Promise<ReadableStreamReadResult<R>> {
    const stream = this.#stream;
    if (stream === null) return Promise.reject(invalidState("The reader is not attached to a stream"));
    stream.__disturbed = true;
    if (stream.__state === "closed") return Promise.resolve({ value: undefined, done: true });
    if (stream.__state === "errored") return Promise.reject(stream.__storedError);
    return stream.__controller.__pull(this);
  }
  releaseLock(): void {
    const stream = this.#stream;
    if (stream === null) return;
    const e = invalidState("Releasing reader");
    for (const r of this.#readRequests) r.reject(e);
    this.#readRequests = [];
    if (!this.#closed.settled) this.#closed.reject(e);
    this.#stream = null;
    stream.__detachReader();
  }
  cancel(reason?: unknown): Promise<void> {
    if (this.#stream === null) return Promise.reject(invalidState("The reader is not attached to a stream"));
    return this.#stream.__cancel(reason);
  }
  get __pendingReads(): number { return this.#readRequests.length; }
  __addReadRequest(): Promise<ReadableStreamReadResult<R>> {
    const d = deferred<ReadableStreamReadResult<R>>();
    this.#readRequests.push(d);
    return d.promise;
  }
  __fulfillRead(chunk: R): boolean {
    const d = this.#readRequests.shift();
    if (d === undefined) return false;
    d.resolve({ value: chunk, done: false });
    return true;
  }
  __closeRequests(): void {
    for (const r of this.#readRequests) r.resolve({ value: undefined, done: true });
    this.#readRequests = [];
    if (!this.#closed.settled) this.#closed.resolve(undefined);
  }
  __errorRequests(e: unknown): void {
    for (const r of this.#readRequests) r.reject(e);
    this.#readRequests = [];
    if (!this.#closed.settled) this.#closed.reject(e);
  }
  get [Symbol.toStringTag](): string { return "ReadableStreamDefaultReader"; }
}

export interface StreamPipeOptions { preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean; signal?: { aborted: boolean; reason?: unknown; addEventListener?: (type: string, listener: () => void) => void } }

/** the source of a lazy stream's construction (never a user's: not exported) */
const LAZY_SOURCE: UnderlyingSource<unknown> = {};
export class ReadableStream<R = unknown> {
  __state: "readable" | "closed" | "errored" = "readable";
  __storedError: unknown = undefined;
  __reader: ReadableStreamDefaultReader<R> | null = null;
  __controller!: ReadableStreamDefaultController<R>;
  __disturbed = false;
  /** A lazy stream (`__lazyOf`): the stream of a Request's or Response's text or bytes body that
   *  nobody has read. Its chunks, and the controller holding them, are made when a reader or a
   *  cancel first needs them; until then a body given the stream takes `__lazySource` (the body's
   *  data) back whole when it reads (`__takeSource`), which leaves the stream locked, disturbed and
   *  closed as Node's read to the end does. hono rebuilds every response it adds a header to as
   *  `new Response(res.body, res)`: without this each one encoded, copied and re-read its body
   *  through a reader (hono_app 1.7x slower). */
  __lazy: (() => R[]) | null = null;
  __lazySource: unknown = undefined;
  __taken = false;
  constructor(underlyingSource?: UnderlyingSource<R> | null, strategy?: QueuingStrategy<R>) {
    if ((underlyingSource as unknown) !== LAZY_SOURCE) {
      const source: UnderlyingSource<R> = underlyingSource === undefined || underlyingSource === null ? {} : underlyingSource;
      if (typeof source !== "object") throw new TypeError("The provided value is not of type 'UnderlyingSource'.");
      if (source.type !== undefined) {
        if (String(source.type) === "bytes") throw new TypeError("garnet: byte streams (type: \"bytes\") are not provided; a default stream of Uint8Array chunks reads the same bytes");
        throw new TypeError("Invalid type is specified");
      }
      this.__controller = new ReadableStreamDefaultController<R>(this, source, highWaterMarkOf(strategy, 1), sizeAlgorithmOf(strategy));
      this.__controller.__start(source);
    }
  }
  /** a lazy stream over `source`, whose chunks `chunks()` makes when first needed */
  static __lazyOf<R>(source: unknown, chunks: () => R[]): ReadableStream<R> {
    const s = new ReadableStream<R>(LAZY_SOURCE as UnderlyingSource<R>);
    s.__lazy = chunks;
    s.__lazySource = source;
    return s;
  }
  /** a lazy stream's controller, made now: its chunks enqueued and the stream closed after them, as
   *  a source's start would */
  __materialize(): void {
    const make = this.__lazy;
    if (make === null) return;
    this.__lazy = null;
    this.__lazySource = undefined;
    const controller = new ReadableStreamDefaultController<R>(this, {}, 1, () => 1);
    this.__controller = controller;
    for (const chunk of make()) controller.enqueue(chunk);
    controller.close();
  }
  /** a lazy stream's source, taken whole by the body that reads it (the stream is then locked,
   *  disturbed and closed); undefined when the stream is not lazy, or was read, cancelled or locked */
  __takeSource(): unknown {
    if (this.__lazy === null || this.__disturbed || this.locked) return undefined;
    const source = this.__lazySource;
    this.__lazy = null;
    this.__lazySource = undefined;
    this.__taken = true;
    this.__disturbed = true;
    this.__state = "closed";
    return source;
  }
  get locked(): boolean { return this.__reader !== null || this.__taken; }
  cancel(reason?: unknown): Promise<void> {
    if (this.locked) return Promise.reject(invalidState("ReadableStream is locked"));
    return this.__cancel(reason);
  }
  getReader(options?: { mode?: string }): ReadableStreamDefaultReader<R> {
    if (options !== undefined && options !== null && options.mode !== undefined) {
      if (String(options.mode) === "byob") throw new TypeError("garnet: BYOB readers are not provided (byte streams)");
      throw new TypeError(`The provided value '${String(options.mode)}' is not a valid enum value of type ReadableStreamReaderMode.`);
    }
    return new ReadableStreamDefaultReader<R>(this);
  }
  pipeThrough<T>(transform: { writable: WritableStream<R>; readable: ReadableStream<T> }, options?: StreamPipeOptions): ReadableStream<T> {
    if (transform === null || typeof transform !== "object" || !(transform.writable instanceof WritableStream) || !(transform.readable instanceof ReadableStream)) {
      throw new TypeError("The provided value is not of type 'ReadableWritablePair'.");
    }
    if (this.locked) throw invalidState("ReadableStream is locked");
    if (transform.writable.locked) throw invalidState("WritableStream is locked");
    handled(this.__pipeTo(transform.writable, options));
    return transform.readable;
  }
  pipeTo(destination: WritableStream<R>, options?: StreamPipeOptions): Promise<void> {
    if (!(destination instanceof WritableStream)) return Promise.reject(new TypeError("The provided value is not of type 'WritableStream'."));
    if (this.locked) return Promise.reject(invalidState("ReadableStream is locked"));
    if (destination.locked) return Promise.reject(invalidState("WritableStream is locked"));
    return this.__pipeTo(destination, options);
  }
  async __pipeTo(destination: WritableStream<R>, options: StreamPipeOptions | undefined): Promise<void> {
    const opts = options ?? {};
    const reader = this.getReader();
    const writer = destination.getWriter();
    const signal = opts.signal;
    try {
      for (;;) {
        if (signal !== undefined && signal.aborted) throw signal.reason === undefined ? new Error("The operation was aborted") : signal.reason;
        if (destination.__state === "errored") throw destination.__storedError;
        if (destination.__state === "closing" || destination.__state === "closed") throw new TypeError("The destination writable stream closed before all data could be piped to it");
        const result = await reader.read();
        if (result.done) break;
        await writer.ready;
        await writer.write(result.value as R);
      }
      if (opts.preventClose !== true) await writer.close();
    } catch (e) {
      const sourceErrored = this.__state === "errored";
      const destErrored = destination.__state === "errored";
      if (sourceErrored && opts.preventAbort !== true) await writer.abort(e).catch(() => undefined);
      else if (destErrored && opts.preventCancel !== true) await reader.cancel(e).catch(() => undefined);
      else if (!sourceErrored && !destErrored) {
        if (opts.preventAbort !== true) await writer.abort(e).catch(() => undefined);
        if (opts.preventCancel !== true) await reader.cancel(e).catch(() => undefined);
      }
      throw e;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }
  tee(): [ReadableStream<R>, ReadableStream<R>] {
    if (this.locked) throw invalidState("ReadableStream is locked");
    const reader = this.getReader();
    let reading = false;
    let canceled1 = false, canceled2 = false;
    let reason1: unknown, reason2: unknown;
    let controller1!: ReadableStreamDefaultController<R>, controller2!: ReadableStreamDefaultController<R>;
    const cancelPromise = deferred<void>();
    handled(cancelPromise.promise);
    const pull = (): Promise<void> => {
      if (reading) return Promise.resolve();
      reading = true;
      return reader.read().then((result) => {
        reading = false;
        if (result.done) {
          if (!canceled1) controller1.close();
          if (!canceled2) controller2.close();
          cancelPromise.resolve(undefined);
          return;
        }
        if (!canceled1) controller1.enqueue(result.value as R);
        if (!canceled2) controller2.enqueue(result.value as R);
      }, (e) => { reading = false; if (!canceled1) controller1.error(e); if (!canceled2) controller2.error(e); cancelPromise.resolve(undefined); });
    };
    const branch1 = new ReadableStream<R>({
      start(c) { controller1 = c; },
      pull,
      cancel(reason) { canceled1 = true; reason1 = reason; if (canceled2) reader.cancel([reason1, reason2]).then(() => cancelPromise.resolve(undefined), (e) => cancelPromise.reject(e)); return cancelPromise.promise; },
    });
    const branch2 = new ReadableStream<R>({
      start(c) { controller2 = c; },
      pull,
      cancel(reason) { canceled2 = true; reason2 = reason; if (canceled1) reader.cancel([reason1, reason2]).then(() => cancelPromise.resolve(undefined), (e) => cancelPromise.reject(e)); return cancelPromise.promise; },
    });
    reader.closed.catch((e) => { if (!canceled1) controller1.error(e); if (!canceled2) controller2.error(e); });
    return [branch1, branch2];
  }
  values(options?: { preventCancel?: boolean }): AsyncIterableIterator<R> {
    const reader = this.getReader();
    const preventCancel = options !== undefined && options !== null && options.preventCancel === true;
    let finished = false;
    const iterator: AsyncIterableIterator<R> = {
      next: (): Promise<IteratorResult<R>> => {
        if (finished) return Promise.resolve({ value: undefined as unknown as R, done: true });
        return reader.read().then((r) => {
          if (r.done) { finished = true; reader.releaseLock(); return { value: undefined as unknown as R, done: true }; }
          return { value: r.value as R, done: false };
        }, (e) => { finished = true; reader.releaseLock(); throw e; });
      },
      return: (value?: unknown): Promise<IteratorResult<R>> => {
        if (finished) return Promise.resolve({ value: value as R, done: true });
        finished = true;
        if (preventCancel) { reader.releaseLock(); return Promise.resolve({ value: value as R, done: true }); }
        return reader.cancel(value).then(() => { reader.releaseLock(); return { value: value as R, done: true }; });
      },
      [Symbol.asyncIterator]() { return iterator; },
    };
    return iterator;
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<R> { return this.values(); }
  static from<T>(iterable: Iterable<T> | AsyncIterable<T>): ReadableStream<T> {
    const it = iterable as { [Symbol.asyncIterator]?: () => AsyncIterator<T>; [Symbol.iterator]?: () => Iterator<T> };
    let iterator: AsyncIterator<T> | Iterator<T>;
    if (typeof it[Symbol.asyncIterator] === "function") iterator = it[Symbol.asyncIterator]!();
    else if (typeof it[Symbol.iterator] === "function") iterator = it[Symbol.iterator]!();
    else throw new TypeError("The provided value is not an iterable");
    return new ReadableStream<T>({
      async pull(controller) {
        const r = await iterator.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      },
      async cancel(reason) {
        if (typeof iterator.return === "function") await iterator.return(reason);
      },
    }, { highWaterMark: 0 });
  }
  __attachReader(reader: ReadableStreamDefaultReader<R>): void { this.__reader = reader; }
  __detachReader(): void { this.__reader = null; }
  __close(): void {
    if (this.__state !== "readable") return;
    this.__lazy = null;   // a lazy stream closed unread: its chunks are never made
    this.__lazySource = undefined;
    this.__state = "closed";
    if (this.__reader !== null) this.__reader.__closeRequests();
  }
  __error(e: unknown): void {
    if (this.__state !== "readable") return;
    this.__state = "errored";
    this.__storedError = e;
    if (this.__reader !== null) this.__reader.__errorRequests(e);
  }
  __cancel(reason: unknown): Promise<void> {
    this.__disturbed = true;
    if (this.__state === "closed") return Promise.resolve();
    if (this.__state === "errored") return Promise.reject(this.__storedError);
    if (this.__lazy !== null) { this.__close(); return Promise.resolve(); }   // no source to tell
    this.__close();
    return this.__controller.__cancel(reason);
  }
  get [Symbol.toStringTag](): string { return "ReadableStream"; }
}

// ---- WritableStream ----

export interface UnderlyingSink<W = unknown> {
  start?: (controller: WritableStreamDefaultController) => unknown;
  write?: (chunk: W, controller: WritableStreamDefaultController) => unknown;
  close?: () => unknown;
  abort?: (reason: unknown) => unknown;
  type?: unknown;
}

export class WritableStreamDefaultController {
  #stream: WritableStream<unknown>;
  #queue: { chunk: unknown; size: number; done: Deferred<void> }[] = [];
  #queueTotalSize = 0;
  #started = false;
  #writing = false;
  #closeRequest: Deferred<void> | null = null;
  readonly #highWaterMark: number;
  readonly #sizeAlgorithm: (chunk: unknown) => number;
  readonly #writeAlgorithm: (chunk: unknown, controller: WritableStreamDefaultController) => unknown;
  readonly #closeAlgorithm: () => unknown;
  readonly #abortAlgorithm: (reason: unknown) => unknown;
  #signal: AbortSignal | undefined;
  #abortController: AbortController | undefined;
  constructor(stream: WritableStream<unknown>, sink: UnderlyingSink<unknown>, highWaterMark: number, size: (chunk: unknown) => number) {
    this.#stream = stream;
    this.#highWaterMark = highWaterMark;
    this.#sizeAlgorithm = size;
    this.#writeAlgorithm = sink.write === undefined ? () => undefined : (chunk, c) => sink.write!.call(sink, chunk, c);
    this.#closeAlgorithm = sink.close === undefined ? () => undefined : () => sink.close!.call(sink);
    this.#abortAlgorithm = sink.abort === undefined ? () => undefined : (reason) => sink.abort!.call(sink, reason);
  }
  get signal(): AbortSignal {
    if (this.#signal === undefined) { this.#abortController = new AbortController(); this.#signal = this.#abortController.signal; }
    return this.#signal;
  }
  error(e?: unknown): void {
    if (this.#stream.__state !== "writable") return;
    this.#stream.__error(e);
  }
  __start(sink: UnderlyingSink<unknown>): void {
    let started: unknown;
    try { started = sink.start === undefined ? undefined : sink.start.call(sink, this); } catch (e) { this.#stream.__error(e); return; }
    Promise.resolve(started).then(() => { this.#started = true; this.#stream.__updateBackpressure(this.__backpressure); this.#advance(); }, (e) => this.#stream.__error(e));
  }
  get __backpressure(): boolean { return this.#highWaterMark - this.#queueTotalSize <= 0; }
  get desiredSize(): number | null {
    const state = this.#stream.__state;
    if (state === "errored" || state === "erroring") return null;
    if (state === "closed") return 0;
    return this.#highWaterMark - this.#queueTotalSize;
  }
  __write(chunk: unknown): Promise<void> {
    let size: number;
    try { size = this.#sizeAlgorithm(chunk); } catch (e) { this.#stream.__error(e); return Promise.reject(e); }
    const done = deferred<void>();
    this.#queue.push({ chunk, size, done });
    this.#queueTotalSize += size;
    this.#stream.__updateBackpressure(this.__backpressure);
    this.#advance();
    return done.promise;
  }
  __close(): Promise<void> {
    this.#closeRequest = deferred<void>();
    this.#advance();
    return this.#closeRequest.promise;
  }
  __abort(reason: unknown): Promise<void> {
    const e = reason;
    for (const w of this.#queue) w.done.reject(e);
    this.#queue = [];
    this.#queueTotalSize = 0;
    if (this.#closeRequest !== null && !this.#closeRequest.settled) this.#closeRequest.reject(e);
    let result: unknown;
    try { result = this.#abortAlgorithm(reason); } catch (err) { return Promise.reject(err); }
    return Promise.resolve(result).then(() => undefined);
  }
  __errorPending(e: unknown): void {
    // the write in flight settles by the sink's own outcome (a transform that terminates its stream
    // still completes the write it is in, the standard's FinishInFlightWrite); the queued ones are rejected
    const inFlight = this.#writing && this.#queue.length > 0 ? this.#queue[0] : null;
    for (const w of this.#queue) if (w !== inFlight) w.done.reject(e);
    this.#queue = inFlight === null ? [] : [inFlight];
    this.#queueTotalSize = inFlight === null ? 0 : inFlight.size;
    if (this.#closeRequest !== null && !this.#closeRequest.settled) this.#closeRequest.reject(e);
  }
  #advance(): void {
    if (!this.#started || this.#writing) return;
    const state = this.#stream.__state;
    if (state === "errored" || state === "erroring" || state === "closed") return;
    if (this.#queue.length === 0) {
      if (this.#closeRequest !== null && !this.#closeRequest.settled && state === "closing") {
        this.#writing = true;
        let closed: unknown;
        try { closed = this.#closeAlgorithm(); } catch (e) { this.#writing = false; this.#stream.__error(e); return; }
        Promise.resolve(closed).then(() => { this.#writing = false; this.#stream.__finishClose(); this.#closeRequest!.resolve(undefined); },
          (e) => { this.#writing = false; this.#stream.__error(e); });
      }
      return;
    }
    const entry = this.#queue[0];
    this.#writing = true;
    let written: unknown;
    try { written = this.#writeAlgorithm(entry.chunk, this); } catch (e) { this.#writing = false; this.#stream.__error(e); return; }
    Promise.resolve(written).then(() => {
      this.#writing = false;
      this.#queue.shift();
      this.#queueTotalSize -= entry.size;
      entry.done.resolve(undefined);
      if (this.#stream.__state === "writable" || this.#stream.__state === "closing") this.#stream.__updateBackpressure(this.__backpressure);
      this.#advance();
    }, (e) => { this.#writing = false; this.#stream.__error(e); });
  }
  get [Symbol.toStringTag](): string { return "WritableStreamDefaultController"; }
}

export class WritableStreamDefaultWriter<W = unknown> {
  #stream: WritableStream<W> | null;
  #ready: Deferred<void>;
  readonly #closed: Deferred<void> = deferred<void>();
  constructor(stream: WritableStream<W>) {
    if (!(stream instanceof WritableStream)) throw new TypeError("WritableStreamDefaultWriter constructor requires a WritableStream");
    if (stream.locked) throw invalidState("WritableStream is locked");
    this.#stream = stream;
    handled(this.#closed.promise);
    this.#ready = deferred<void>();
    handled(this.#ready.promise);
    stream.__attachWriter(this);
    const state = stream.__state;
    if (state === "writable") { if (!stream.__backpressure) this.#ready.resolve(undefined); }
    else if (state === "erroring" || state === "errored") { this.#ready.reject(stream.__storedError); this.#closed.reject(stream.__storedError); }
    else if (state === "closed") { this.#ready.resolve(undefined); this.#closed.resolve(undefined); }
    else this.#ready.resolve(undefined);   // closing: writes are refused, ready is resolved
  }
  get closed(): Promise<void> { return this.#closed.promise; }
  get ready(): Promise<void> { return this.#ready.promise; }
  get desiredSize(): number | null {
    if (this.#stream === null) throw invalidState("The writer is not attached to a stream");
    return this.#stream.__controller.desiredSize;
  }
  write(chunk?: W): Promise<void> {
    const stream = this.#stream;
    if (stream === null) return Promise.reject(invalidState("The writer is not attached to a stream"));
    if (stream.__state === "errored" || stream.__state === "erroring") return Promise.reject(stream.__storedError);
    if (stream.__state === "closing" || stream.__state === "closed") return Promise.reject(invalidState("WritableStream is closed"));
    return stream.__controller.__write(chunk);
  }
  /** the writer's close and abort act on the stream it holds the lock of (the stream's own refuse a locked stream) */
  close(): Promise<void> {
    const stream = this.#stream;
    if (stream === null) return Promise.reject(invalidState("The writer is not attached to a stream"));
    return stream.__close();
  }
  abort(reason?: unknown): Promise<void> {
    const stream = this.#stream;
    if (stream === null) return Promise.reject(invalidState("The writer is not attached to a stream"));
    return stream.__abort(reason);
  }
  releaseLock(): void {
    const stream = this.#stream;
    if (stream === null) return;
    const e = invalidState("Releasing writer");
    if (!this.#ready.settled) this.#ready.reject(e);
    if (!this.#closed.settled) this.#closed.reject(e);
    this.#stream = null;
    stream.__detachWriter();
  }
  __setBackpressure(backpressure: boolean): void {
    if (backpressure) { if (this.#ready.settled) { this.#ready = deferred<void>(); handled(this.#ready.promise); } }
    else if (!this.#ready.settled) this.#ready.resolve(undefined);
  }
  __closeSettled(): void { if (!this.#closed.settled) this.#closed.resolve(undefined); if (!this.#ready.settled) this.#ready.resolve(undefined); }
  __errorSettled(e: unknown): void { if (!this.#closed.settled) this.#closed.reject(e); if (!this.#ready.settled) this.#ready.reject(e); }
  get [Symbol.toStringTag](): string { return "WritableStreamDefaultWriter"; }
}

export class WritableStream<W = unknown> {
  __state: "writable" | "closing" | "erroring" | "errored" | "closed" = "writable";
  __storedError: unknown = undefined;
  __writer: WritableStreamDefaultWriter<W> | null = null;
  __controller!: WritableStreamDefaultController;
  __backpressure = false;
  constructor(underlyingSink?: UnderlyingSink<W> | null, strategy?: QueuingStrategy<W>) {
    const sink: UnderlyingSink<W> = underlyingSink === undefined || underlyingSink === null ? {} : underlyingSink;
    if (typeof sink !== "object") throw new TypeError("The provided value is not of type 'UnderlyingSink'.");
    if (sink.type !== undefined) throw new RangeError("Invalid type is specified");
    this.__controller = new WritableStreamDefaultController(this as WritableStream<unknown>, sink as UnderlyingSink<unknown>, highWaterMarkOf(strategy, 1), sizeAlgorithmOf(strategy) as (chunk: unknown) => number);
    this.__controller.__start(sink as UnderlyingSink<unknown>);
  }
  get locked(): boolean { return this.__writer !== null; }
  abort(reason?: unknown): Promise<void> {
    if (this.locked) return Promise.reject(invalidState("WritableStream is locked"));
    return this.__abort(reason);
  }
  close(): Promise<void> {
    if (this.locked) return Promise.reject(invalidState("WritableStream is locked"));
    return this.__close();
  }
  getWriter(): WritableStreamDefaultWriter<W> { return new WritableStreamDefaultWriter<W>(this); }
  __attachWriter(writer: WritableStreamDefaultWriter<W>): void { this.__writer = writer; }
  __detachWriter(): void { this.__writer = null; }
  __updateBackpressure(backpressure: boolean): void {
    this.__backpressure = backpressure;
    if (this.__writer !== null) this.__writer.__setBackpressure(backpressure);
  }
  __close(): Promise<void> {
    if (this.__state === "closing") return Promise.reject(invalidState("Failure to close WritableStream"));
    if (this.__state === "closed") return Promise.reject(invalidState("WritableStream is closed"));
    if (this.__state === "errored" || this.__state === "erroring") return Promise.reject(this.__storedError);
    this.__state = "closing";
    return this.__controller.__close();
  }
  __finishClose(): void {
    this.__state = "closed";
    if (this.__writer !== null) this.__writer.__closeSettled();
  }
  __abort(reason: unknown): Promise<void> {
    if (this.__state === "closed" || this.__state === "errored") return Promise.resolve();
    const error = reason === undefined ? new Error("The operation was aborted") : reason;
    this.__state = "erroring";
    this.__storedError = error;
    if (this.__writer !== null) this.__writer.__errorSettled(error);
    return this.__controller.__abort(error).then(() => { this.__state = "errored"; }, (e) => { this.__state = "errored"; throw e; });
  }
  __error(e: unknown): void {
    if (this.__state === "errored" || this.__state === "closed") return;
    this.__state = "errored";
    this.__storedError = e;
    this.__controller.__errorPending(e);
    if (this.__writer !== null) this.__writer.__errorSettled(e);
  }
  get [Symbol.toStringTag](): string { return "WritableStream"; }
}

// ---- TransformStream ----

export interface Transformer<I = unknown, O = unknown> {
  start?: (controller: TransformStreamDefaultController<O>) => unknown;
  transform?: (chunk: I, controller: TransformStreamDefaultController<O>) => unknown;
  flush?: (controller: TransformStreamDefaultController<O>) => unknown;
  cancel?: (reason: unknown) => unknown;
  readableType?: unknown;
  writableType?: unknown;
}

export class TransformStreamDefaultController<O = unknown> {
  #stream: TransformStream<unknown, O>;
  constructor(stream: TransformStream<unknown, O>) { this.#stream = stream; }
  get desiredSize(): number | null { return this.#stream.__readableController.desiredSize; }
  enqueue(chunk?: O): void {
    const rc = this.#stream.__readableController;
    if (this.#stream.readable.__state !== "readable") throw invalidState("The readable side is not readable");
    try { rc.enqueue(chunk as O); } catch (e) { this.#stream.__errorWritableAndUnblock(e); throw e; }
    this.#stream.__setBackpressure((rc.desiredSize ?? 0) <= 0);
  }
  error(reason?: unknown): void { this.#stream.__error(reason); }
  terminate(): void {
    const rc = this.#stream.__readableController;
    if (this.#stream.readable.__state === "readable") rc.close();
    this.#stream.__errorWritableAndUnblock(new TypeError("The stream has been terminated"));
  }
  get [Symbol.toStringTag](): string { return "TransformStreamDefaultController"; }
}

export class TransformStream<I = unknown, O = unknown> {
  readonly readable: ReadableStream<O>;
  readonly writable: WritableStream<I>;
  __readableController!: ReadableStreamDefaultController<O>;
  #backpressure = true;
  #backpressureChange: Deferred<void> = deferred<void>();
  constructor(transformer?: Transformer<I, O> | null, writableStrategy?: QueuingStrategy<I>, readableStrategy?: QueuingStrategy<O>) {
    const t: Transformer<I, O> = transformer === undefined || transformer === null ? {} : transformer;
    if (typeof t !== "object") throw new TypeError("The provided value is not of type 'Transformer'.");
    if (t.readableType !== undefined) throw new RangeError("Invalid readableType specified");
    if (t.writableType !== undefined) throw new RangeError("Invalid writableType specified");
    const controller = new TransformStreamDefaultController<O>(this as TransformStream<unknown, O>);
    const startDeferred = deferred<void>();
    handled(startDeferred.promise);
    const transformAlgorithm = t.transform === undefined
      ? (chunk: I): unknown => { controller.enqueue(chunk as unknown as O); return undefined; }
      : (chunk: I): unknown => t.transform!.call(t, chunk, controller);
    const flushAlgorithm = t.flush === undefined ? (): unknown => undefined : (): unknown => t.flush!.call(t, controller);
    const cancelAlgorithm = t.cancel === undefined ? (): unknown => undefined : (reason: unknown): unknown => t.cancel!.call(t, reason);
    this.readable = new ReadableStream<O>({
      start: (rc) => { this.__readableController = rc; return startDeferred.promise; },
      pull: () => { this.__setBackpressure(false); return undefined; },
      cancel: (reason) => { this.__errorWritableAndUnblock(reason); return Promise.resolve(cancelAlgorithm(reason)); },
    }, { highWaterMark: highWaterMarkOf(readableStrategy, 0), size: readableStrategy === undefined ? undefined : readableStrategy.size });
    this.writable = new WritableStream<I>({
      start: () => startDeferred.promise,
      write: (chunk) => this.#transformWrite(chunk, transformAlgorithm),
      close: () => this.#flushClose(flushAlgorithm),
      abort: (reason) => { this.__error(reason); return Promise.resolve(cancelAlgorithm(reason)); },
    }, { highWaterMark: highWaterMarkOf(writableStrategy, 1), size: writableStrategy === undefined ? undefined : writableStrategy.size });
    let started: unknown;
    try { started = t.start === undefined ? undefined : t.start.call(t, controller); } catch (e) { startDeferred.reject(e); return; }
    Promise.resolve(started).then(() => startDeferred.resolve(undefined), (e) => startDeferred.reject(e));
  }
  async #transformWrite(chunk: I, transform: (chunk: I) => unknown): Promise<void> {
    while (this.#backpressure && this.readable.__state === "readable") await this.#backpressureChange.promise;
    if (this.writable.__state === "errored" || this.writable.__state === "erroring") throw this.writable.__storedError;
    try { await transform(chunk); } catch (e) { this.__error(e); throw e; }
  }
  async #flushClose(flush: () => unknown): Promise<void> {
    try { await flush(); } catch (e) { this.__error(e); throw e; }
    if (this.readable.__state === "readable") this.__readableController.close();
  }
  __setBackpressure(backpressure: boolean): void {
    if (this.#backpressure === backpressure) return;
    this.#backpressure = backpressure;
    const previous = this.#backpressureChange;
    this.#backpressureChange = deferred<void>();
    handled(this.#backpressureChange.promise);
    previous.resolve(undefined);
  }
  __errorWritableAndUnblock(e: unknown): void {
    this.writable.__error(e);
    this.__setBackpressure(false);
  }
  __error(e: unknown): void {
    if (this.readable.__state === "readable") this.__readableController.error(e);
    this.__errorWritableAndUnblock(e);
  }
  get [Symbol.toStringTag](): string { return "TransformStream"; }
}

// ---- the text streams ----

export class TextEncoderStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<string>;
  #pendingHighSurrogate = "";
  constructor() {
    const encoder = new TextEncoder();
    const ts = new TransformStream<string, Uint8Array>({
      transform: (chunk, controller) => {
        let s = this.#pendingHighSurrogate + String(chunk);
        this.#pendingHighSurrogate = "";
        if (s.length > 0) {
          const last = s.charCodeAt(s.length - 1);
          if (last >= 0xd800 && last <= 0xdbff) { this.#pendingHighSurrogate = s.slice(-1); s = s.slice(0, -1); }
        }
        if (s.length > 0) controller.enqueue(encoder.encode(s));
      },
      flush: (controller) => {
        if (this.#pendingHighSurrogate.length > 0) { controller.enqueue(encoder.encode(this.#pendingHighSurrogate)); this.#pendingHighSurrogate = ""; }
      },
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
  get encoding(): string { return "utf-8"; }
  get [Symbol.toStringTag](): string { return "TextEncoderStream"; }
}

/** The bytes at the end of a chunk that begin an incomplete UTF-8 sequence (0 when none). */
function incompleteTail(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= 3 && back <= n; back++) {
    const b = bytes[n - back];
    if ((b & 0xc0) === 0x80) continue;   // a continuation byte: look further back for its lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}
export class TextDecoderStream {
  readonly readable: ReadableStream<string>;
  readonly writable: WritableStream<ArrayBufferView | ArrayBuffer>;
  readonly #encoding: string;
  readonly #fatal: boolean;
  readonly #ignoreBOM: boolean;
  #pending: Uint8Array = new Uint8Array(0);
  constructor(label: string = "utf-8", options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    const name = String(label).trim().toLowerCase();
    if (name !== "utf-8" && name !== "utf8" && name !== "unicode-1-1-utf-8") throw new RangeError(`The "${label}" encoding is not supported`);
    this.#encoding = "utf-8";
    this.#fatal = options !== undefined && options !== null && options.fatal === true;
    this.#ignoreBOM = options !== undefined && options !== null && options.ignoreBOM === true;
    const decoder = new TextDecoder("utf-8", { fatal: this.#fatal, ignoreBOM: this.#ignoreBOM });
    const ts = new TransformStream<ArrayBufferView | ArrayBuffer, string>({
      transform: (chunk, controller) => {
        let bytes: Uint8Array;
        if (chunk instanceof ArrayBuffer) bytes = new Uint8Array(chunk);
        else if (chunk !== null && typeof chunk === "object" && typeof (chunk as ArrayBufferView).byteLength === "number") bytes = new Uint8Array((chunk as ArrayBufferView).buffer, (chunk as ArrayBufferView).byteOffset, (chunk as ArrayBufferView).byteLength);
        else throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
        let all = bytes;
        if (this.#pending.length > 0) { all = new Uint8Array(this.#pending.length + bytes.length); all.set(this.#pending); all.set(bytes, this.#pending.length); }
        const tail = incompleteTail(all);
        this.#pending = tail > 0 ? all.slice(all.length - tail) : new Uint8Array(0);
        const head = tail > 0 ? all.subarray(0, all.length - tail) : all;
        if (head.length > 0) controller.enqueue(decoder.decode(head));
      },
      flush: (controller) => {
        if (this.#pending.length > 0) { const s = decoder.decode(this.#pending); this.#pending = new Uint8Array(0); controller.enqueue(s); }
      },
    });
    this.readable = ts.readable;
    this.writable = ts.writable;
  }
  get encoding(): string { return this.#encoding; }
  get fatal(): boolean { return this.#fatal; }
  get ignoreBOM(): boolean { return this.#ignoreBOM; }
  get [Symbol.toStringTag](): string { return "TextDecoderStream"; }
}
