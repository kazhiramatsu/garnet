// node:tty: isatty, and the ReadStream and WriteStream classes of the standard
// streams (process.stdin, process.stdout, process.stderr). A write to a
// standard stream completes synchronously; stdin is read by the event loop
// while the stream is flowing or being read, and a paused stdin does not keep
// the process alive. Raw mode (termios) is not available: setRawMode only
// records the flag.
import { Readable, Writable } from "./stream";
import { Buffer, fromView } from "./buffer";
import { host } from "./host";
import { lastError } from "./errors";

export function isatty(fd: number): boolean {
  return Number.isInteger(fd) && fd >= 0 && fd <= 2147483647 && host.isatty(fd);
}

export class WriteStream extends Writable {
  readonly fd: number;
  /** true on a terminal; absent (undefined) otherwise, as Node's streams have it. */
  readonly isTTY: true | undefined;
  columns: number | undefined;
  rows: number | undefined;
  constructor(fd: number) {
    super({ decodeStrings: false, autoDestroy: false });
    this.fd = fd;
    this.isTTY = host.isatty(fd) ? true : undefined;
    const size = this.isTTY ? host.ttySize(fd) : undefined;
    this.columns = size === undefined ? undefined : size[0];
    this.rows = size === undefined ? undefined : size[1];
    this.isStdio = fd === 1 || fd === 2;
  }
  _write(chunk: string | Uint8Array, encoding: string, callback: (error?: Error | null) => void): void {
    let data: string | Uint8Array = chunk;
    if (typeof chunk === "string" && encoding !== "utf8" && encoding !== "utf-8" && encoding !== "buffer") data = Buffer.from(chunk, encoding);
    const total = typeof data === "string" ? host.utf8Length(data) : data.length;
    let offset = 0;
    let error: Error | undefined;
    while (offset < total) {
      const written = host.write(this.fd, data, offset, total - offset);
      if (written < 0) { error = lastError("write"); break; }
      offset += written;
    }
    callback(error);
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void { callback(error); }
  getColorDepth(_env?: object): number { return this.isTTY === true ? 8 : 1; }
  hasColors(count: number | object = 16, _env?: object): boolean {
    if (typeof count !== "number") count = 16;
    return this.isTTY === true && count <= 256;
  }
  getWindowSize(): [number, number] { return [this.columns === undefined ? 80 : this.columns, this.rows === undefined ? 24 : this.rows]; }
  clearLine(dir: number, callback?: () => void): boolean {
    return this.write(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", callback);
  }
  clearScreenDown(callback?: () => void): boolean { return this.write("\x1b[0J", callback); }
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
    if (typeof y === "function") { callback = y; y = undefined; }
    return this.write(typeof y !== "number" ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`, callback);
  }
  moveCursor(dx: number, dy: number, callback?: () => void): boolean {
    let seq = "";
    if (dx < 0) seq += `\x1b[${-dx}D`; else if (dx > 0) seq += `\x1b[${dx}C`;
    if (dy < 0) seq += `\x1b[${-dy}A`; else if (dy > 0) seq += `\x1b[${dy}B`;
    return this.write(seq, callback);
  }
}

export class ReadStream extends Readable {
  readonly fd: number;
  readonly isTTY: true | undefined;
  isRaw = false;
  private watchId: number | null = null;
  constructor(fd: number) {
    super({ highWaterMark: 65536 });
    this.fd = fd;
    this.isTTY = host.isatty(fd) ? true : undefined;
  }
  _read(_size: number): void {
    if (this.watchId !== null) return;
    this.watchId = host.watchFd(this.fd,
      (bytes) => { if (!this.push(fromView(bytes))) this.stopWatching(); },
      () => { this.stopWatching(); this.push(null); });
  }
  private stopWatching(): void {
    if (this.watchId !== null) { host.unwatchFd(this.watchId); this.watchId = null; }
  }
  pause(): this {
    super.pause();
    this.stopWatching();
    return this;
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopWatching();
    callback(error);
  }
  setRawMode(mode: boolean): this { this.isRaw = !!mode; return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

const tty = { isatty, ReadStream, WriteStream };
export default tty;
