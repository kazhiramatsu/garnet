// fs.createReadStream / fs.createWriteStream (docs/node_compat_design.md): the file is
// opened through the stream's construct phase on a later turn ('open' and 'ready', or
// 'error' when the open failed), reads and writes are the synchronous calls driven by the
// stream's demand, the close completes on a later turn. Compiled when the program names
// createReadStream or createWriteStream (or imports this module); registers the classes
// with node:fs when it loads.
import { Readable, Writable } from "../stream";
import { Buffer } from "../buffer";
import { host } from "../host";
import { invalidArgType, outOfRange as streamOutOfRange } from "../errors";
import { openSync, closeSync, readSync, writeSync, _pathOf as pathOf, _setStreamFactory, PathLike } from "../fs";

export interface ReadStreamOptions { flags?: string; encoding?: string; fd?: number; mode?: number; autoClose?: boolean; emitClose?: boolean; start?: number; end?: number; highWaterMark?: number }
export interface WriteStreamOptions { flags?: string; encoding?: string; fd?: number; mode?: number; autoClose?: boolean; emitClose?: boolean; start?: number; highWaterMark?: number; flush?: boolean }
function validateOffset(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value) || value < 0) throw streamOutOfRange(name, ">= 0 && <= 9007199254740991", value);
}
export class ReadStream extends Readable {
  readonly path: string | undefined;
  fd: number | null;
  readonly flags: string;
  readonly mode: number;
  readonly start: number | undefined;
  readonly end: number;
  pos: number | undefined;
  bytesRead: number;
  readonly autoClose: boolean;
  /** No file descriptor yet (not opened, or closed again). */
  get pending(): boolean { return this.fd === null; }
  constructor(p: PathLike | undefined, options?: ReadStreamOptions | string) {
    const opts: ReadStreamOptions = typeof options === "string" ? { encoding: options } : (options === undefined || options === null ? {} : options);
    const holder: { stream: ReadStream | null } = { stream: null };
    const needsOpen = typeof opts.fd !== "number";
    // validated before the base constructor: it schedules the open, which must not run on a half-built stream
    validateOffset(opts.start, "start");
    validateOffset(opts.end === Infinity ? undefined : opts.end, "end");
    const end = opts.end === undefined ? Infinity : opts.end;
    if (opts.start !== undefined && end < opts.start) throw streamOutOfRange("start", `<= "end" (here: ${end})`, opts.start);
    const filePath = needsOpen ? pathOf(p as PathLike) : undefined;
    super({ highWaterMark: opts.highWaterMark === undefined ? 65536 : opts.highWaterMark, encoding: opts.encoding, emitClose: opts.emitClose !== false,
            autoDestroy: opts.autoClose !== false, construct: needsOpen ? (callback) => holder.stream!.openFile(callback) : undefined });
    holder.stream = this;
    this.flags = opts.flags === undefined ? "r" : opts.flags;
    this.mode = opts.mode === undefined ? 0o666 : opts.mode;
    this.start = opts.start;
    this.end = end;
    this.pos = this.start;
    this.bytesRead = 0;
    this.autoClose = opts.autoClose !== false;
    this.path = filePath;
    this.fd = needsOpen ? null : (opts.fd as number);
  }
  /** The open completes on a later turn, as Node's asynchronous open does. */
  private openFile(callback: (error?: Error | null) => void): void {
    host.immediate(() => {
      let fd: number;
      try { fd = openSync(this.path as string, this.flags, this.mode); } catch (e) { callback(e as Error); return; }
      this.fd = fd;
      this.emit("open", fd);
      this.emit("ready");
      callback();
    }, undefined);
  }
  _read(n: number): void {
    if (this.fd === null) return;
    const position = this.pos === undefined ? this.bytesRead : this.pos;
    const toRead = this.end === Infinity ? n : Math.min(n, this.end - position + 1);
    if (toRead <= 0) { this.push(null); return; }
    const buf = Buffer.alloc(toRead);
    let got: number;
    try { got = readSync(this.fd, buf, 0, toRead, this.pos === undefined ? null : this.pos); } catch (e) { this.destroy(e as Error); return; }
    if (got === 0) { this.push(null); return; }
    this.bytesRead += got;
    if (this.pos !== undefined) this.pos += got;
    this.push(got === toRead ? buf : buf.subarray(0, got));
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.fd !== null && this.autoClose) {
      try { closeSync(this.fd); } catch (e) { if (!error) error = e as Error; }
      this.fd = null;
    }
    host.immediate(() => callback(error), undefined);   // 'close' on a later turn, as after Node's asynchronous close
  }
  close(callback?: (error?: Error | null) => void): void {
    if (callback !== undefined) {
      if (this.destroyed) host.nextTick(() => callback(), undefined);
      else this.once("close", () => callback());
    }
    this.destroy();
  }
}
export class WriteStream extends Writable {
  readonly path: string | undefined;
  fd: number | null;
  readonly flags: string;
  readonly mode: number;
  readonly start: number | undefined;
  pos: number | undefined;
  bytesWritten: number;
  readonly autoClose: boolean;
  /** No file descriptor yet (not opened, or closed again). */
  get pending(): boolean { return this.fd === null; }
  constructor(p: PathLike | undefined, options?: WriteStreamOptions | string) {
    const opts: WriteStreamOptions = typeof options === "string" ? { encoding: options } : (options === undefined || options === null ? {} : options);
    const holder: { stream: WriteStream | null } = { stream: null };
    const needsOpen = typeof opts.fd !== "number";
    validateOffset(opts.start, "start");
    const filePath = needsOpen ? pathOf(p as PathLike) : undefined;
    super({ highWaterMark: opts.highWaterMark === undefined ? 16384 : opts.highWaterMark, defaultEncoding: opts.encoding, emitClose: opts.emitClose !== false,
            autoDestroy: opts.autoClose !== false, construct: needsOpen ? (callback) => holder.stream!.openFile(callback) : undefined });
    holder.stream = this;
    this.flags = opts.flags === undefined ? "w" : opts.flags;
    this.mode = opts.mode === undefined ? 0o666 : opts.mode;
    this.start = opts.start;
    this.pos = this.start;
    this.bytesWritten = 0;
    this.autoClose = opts.autoClose !== false;
    this.path = filePath;
    this.fd = needsOpen ? null : (opts.fd as number);
  }
  /** The open completes on a later turn, as Node's asynchronous open does. */
  private openFile(callback: (error?: Error | null) => void): void {
    host.immediate(() => {
      let fd: number;
      try { fd = openSync(this.path as string, this.flags, this.mode); } catch (e) { callback(e as Error); return; }
      this.fd = fd;
      this.emit("open", fd);
      this.emit("ready");
      callback();
    }, undefined);
  }
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    if (this.fd === null) { callback(new Error("Cannot call write after a stream was destroyed")); return; }
    let offset = 0;
    try {
      while (offset < chunk.length) {
        const n = writeSync(this.fd, chunk, offset, chunk.length - offset, this.pos === undefined ? null : this.pos);
        offset += n;
        this.bytesWritten += n;
        if (this.pos !== undefined) this.pos += n;
      }
    } catch (e) {
      callback(e as Error);
      return;
    }
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.fd !== null && this.autoClose) {
      try { closeSync(this.fd); } catch (e) { if (!error) error = e as Error; }
      this.fd = null;
    }
    host.immediate(() => callback(error), undefined);   // 'close' on a later turn, as after Node's asynchronous close
  }
  close(callback?: (error?: Error | null) => void): void {
    if (callback !== undefined) {
      if (this.closed) { host.nextTick(() => callback(), undefined); return; }
      this.once("close", () => callback());
    }
    if (!this.autoClose) this.once("finish", () => this.destroy());
    this.end();
  }
}

_setStreamFactory({
  read: (p: PathLike, options?: ReadStreamOptions | string): ReadStream => new ReadStream(p, options),
  write: (p: PathLike, options?: WriteStreamOptions | string): WriteStream => new WriteStream(p, options),
});
