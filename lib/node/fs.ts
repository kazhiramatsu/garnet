// node:fs (docs/node_compat_design.md, N2): the synchronous API over the host,
// the promise API and the callback API over it (an operation runs when its
// microtask does, so it completes after the current turn, as Node's do).
// Errors are Node's: `code`, `errno`, `syscall`, `path` (and `dest`).
import { host } from "./host";
import { systemError, lastError, invalidArgType, codedTypeError, codedRangeError, ErrnoException, SystemError } from "./errors";
import { Buffer, fromView, normalizeEncoding } from "./buffer";
import { join, dirname, resolve } from "./path";

export type PathLike = string | Buffer;
export type BufferEncoding = string;
export interface ReadOptions { encoding?: string | null; flag?: string }
export interface WriteOptions { encoding?: string | null; mode?: number; flag?: string }
export interface ReaddirOptions { encoding?: string | null; withFileTypes?: boolean; recursive?: boolean }
export interface MkdirOptions { recursive?: boolean; mode?: number | string }
export interface RmOptions { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }
export interface StatOptions { throwIfNoEntry?: boolean; bigint?: false }
type Callback<T> = (err: NodeJS_ErrnoException | null, value: T) => void;
type NodeJS_ErrnoException = Error & { code?: string; errno?: number; syscall?: string; path?: string };

const darwin = host.platform === "darwin";
export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  O_CREAT: darwin ? 0x200 : 0o100, O_EXCL: darwin ? 0x800 : 0o200, O_TRUNC: darwin ? 0x400 : 0o1000,
  O_APPEND: darwin ? 8 : 0o2000, O_NOCTTY: darwin ? 0x20000 : 0o400, O_SYNC: darwin ? 0x80 : 0o4010000, O_NONBLOCK: darwin ? 4 : 0o4000,
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100, S_IRWXG: 0o70, S_IRGRP: 0o40, S_IWGRP: 0o20, S_IXGRP: 0o10, S_IRWXO: 0o7, S_IROTH: 0o4, S_IWOTH: 0o2, S_IXOTH: 0o1,
  UV_FS_COPYFILE_EXCL: 1, UV_FS_O_FILEMAP: 0,
};

function pathOf(p: PathLike, name: string = "path"): string {
  if (typeof p === "string") return p;
  if (p instanceof Uint8Array) return Buffer.from(p).toString();
  throw invalidArgType(name, "of type string or an instance of Buffer or URL", p);
}
function fail(syscall: string, path?: string, dest?: string): ErrnoException { return lastError(syscall, path, dest); }
function modeOf(mode: number | string | undefined, dflt: number): number {
  if (mode === undefined) return dflt;
  if (typeof mode === "string") { const v = parseInt(mode, 8); if (v !== v) throw invalidArgType("mode", "of type number or an octal string", mode); return v; }
  return mode;
}
function encodingArg(options: unknown, name: string = "options"): { encoding: string | null; flag?: string; mode?: number; withFileTypes?: boolean; recursive?: boolean } {
  if (options === undefined || options === null) return { encoding: null };
  if (typeof options === "string") { if (options !== "buffer" && normalizeEncoding(options) === undefined) throw codedTypeError("ERR_INVALID_ARG_VALUE", "The argument '" + name + "' is invalid encoding. Received '" + options + "'"); return { encoding: options === "buffer" ? null : options }; }
  if (typeof options !== "object") throw invalidArgType(name, "one of type string or an instance of Object", options);
  const o = options as { encoding?: string | null; flag?: string; mode?: number | string; withFileTypes?: boolean; recursive?: boolean };
  const enc = o.encoding === undefined || o.encoding === null || o.encoding === "buffer" ? null : o.encoding;
  if (enc !== null && normalizeEncoding(enc) === undefined) throw codedTypeError("ERR_INVALID_ARG_VALUE", "The argument 'encoding' is invalid encoding. Received '" + enc + "'");
  return { encoding: enc, flag: o.flag, mode: o.mode === undefined ? undefined : modeOf(o.mode, 0o666), withFileTypes: o.withFileTypes, recursive: o.recursive };
}

// ---- stat ----
export class Stats {
  dev: number; mode: number; nlink: number; uid: number; gid: number; rdev: number = 0; blksize: number; ino: number; size: number; blocks: number;
  atimeMs: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number;
  atime: Date; mtime: Date; ctime: Date; birthtime: Date;
  constructor(a: number[]) {
    this.size = a[1]; this.mtimeMs = a[2]; this.mode = a[3]; this.uid = a[4]; this.gid = a[5]; this.atimeMs = a[6]; this.ctimeMs = a[7]; this.birthtimeMs = a[8];
    this.nlink = a[9]; this.dev = a[10]; this.ino = a[11]; this.blksize = a[12]; this.blocks = a[13];
    this.atime = new Date(this.atimeMs); this.mtime = new Date(this.mtimeMs); this.ctime = new Date(this.ctimeMs); this.birthtime = new Date(this.birthtimeMs);
  }
  isFile(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFREG; }
  isDirectory(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFDIR; }
  isSymbolicLink(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFLNK; }
  isFIFO(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFIFO; }
  isSocket(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFSOCK; }
  isCharacterDevice(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFCHR; }
  isBlockDevice(): boolean { return (this.mode & constants.S_IFMT) === constants.S_IFBLK; }
}
export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  readonly path: string;
  private readonly kind: number;
  constructor(name: string, kind: number, parentPath: string) { this.name = name; this.kind = kind; this.parentPath = parentPath; this.path = parentPath; }
  isFile(): boolean { return this.kind === 1; }
  isDirectory(): boolean { return this.kind === 2; }
  isSymbolicLink(): boolean { return this.kind === 3; }
  isFIFO(): boolean { return this.kind === 4; }
  isSocket(): boolean { return this.kind === 5; }
  isCharacterDevice(): boolean { return this.kind === 6; }
  isBlockDevice(): boolean { return this.kind === 7; }
}
export function statSync(p: PathLike, options?: StatOptions): Stats | undefined {
  const s = pathOf(p);
  const a = host.stat(s, true);
  if (a === undefined) {
    if (options !== undefined && options.throwIfNoEntry === false && host.lastError() === "ENOENT") return undefined;
    throw fail("stat", s);
  }
  return new Stats(a);
}
export function lstatSync(p: PathLike, options?: StatOptions): Stats | undefined {
  const s = pathOf(p);
  const a = host.stat(s, false);
  if (a === undefined) {
    if (options !== undefined && options.throwIfNoEntry === false && host.lastError() === "ENOENT") return undefined;
    throw fail("lstat", s);
  }
  return new Stats(a);
}
export function fstatSync(fd: number): Stats {
  const a = host.fstat(fd);
  if (a === undefined) throw fail("fstat");
  return new Stats(a);
}
export function existsSync(p: PathLike): boolean {
  try { return host.access(pathOf(p), 0); } catch (e) { return false; }
}
export function accessSync(p: PathLike, mode: number = 0): void {
  const s = pathOf(p);
  if (!host.access(s, mode)) throw fail("access", s);
}

// ---- whole files ----
function decodeFile(bytes: Uint8Array, encoding: string | null): Buffer | string {
  const buf = fromView(bytes);
  return encoding === null ? buf : buf.toString(encoding);
}
export function readFileSync(p: PathLike | number, options?: string | ReadOptions | null): Buffer | string {
  const o = encodingArg(options);
  if (typeof p === "number") {
    const bytes = host.readFile(p);
    if (bytes === undefined) throw fail("read");
    return decodeFile(bytes, o.encoding);
  }
  const s = pathOf(p);
  let bytes: Uint8Array | undefined;
  if (o.flag !== undefined && o.flag !== "r") {
    const fd = openSync(s, o.flag);
    try { bytes = host.readFile(fd); if (bytes === undefined) throw fail("read", s); } finally { host.close(fd); }
  } else {
    bytes = host.readFile(s);
    if (bytes === undefined) {
      if (host.lastError() === "EISDIR") throw fail("read");   // Node's read error names no path
      throw fail("open", s);
    }
  }
  return decodeFile(bytes, o.encoding);
}
function dataBytes(data: unknown, encoding: string | null): string | Uint8Array {
  if (typeof data === "string") return encoding === null || normalizeEncoding(encoding) === "utf8" ? data : Buffer.from(data, encoding);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) { const v = data as ArrayBufferView; return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
  throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
}
export function writeFileSync(file: PathLike | number, data: string | Uint8Array, options?: string | WriteOptions | null): void {
  const o = encodingArg(options);
  const bytes = dataBytes(data, o.encoding);
  if (typeof file === "number") { if (!host.writeFile(file, bytes)) throw fail("write"); return; }
  const s = pathOf(file);
  if (!host.writeFile(s, bytes, o.flag === undefined ? "w" : o.flag, o.mode === undefined ? 0o666 : o.mode)) throw fail("open", s);
}
export function appendFileSync(file: PathLike | number, data: string | Uint8Array, options?: string | WriteOptions | null): void {
  const o = encodingArg(options);
  writeFileSync(file, data, { encoding: o.encoding, mode: o.mode, flag: o.flag === undefined ? "a" : o.flag });
}
export function truncateSync(p: PathLike, len: number = 0): void {
  const s = pathOf(p);
  if (!host.truncate(s, len)) throw fail("open", s);
}
export function ftruncateSync(fd: number, len: number = 0): void { if (!host.truncate(fd, len)) throw fail("ftruncate"); }
export function copyFileSync(src: PathLike, dest: PathLike, mode: number = 0): void {
  const a = pathOf(src, "src"), b = pathOf(dest, "dest");
  if (!host.copyFile(a, b, (mode & constants.COPYFILE_EXCL) !== 0)) throw fail("copyfile", a, b);
}

// ---- directories ----
export function readdirSync(p: PathLike, options?: string | ReaddirOptions | null): string[] | Dirent[] | Buffer[] {
  const o = encodingArg(options);
  const s = pathOf(p);
  const names: string[] = [];
  const kinds: number[] = [];
  const parents: string[] = [];
  const list = (dir: string, prefix: string): void => {
    const r = host.readdir(dir);
    if (r === undefined) throw fail("scandir", dir);
    for (let i = 0; i < r[0].length; i++) {
      const name = prefix === "" ? r[0][i] : prefix + "/" + r[0][i];
      names.push(name); kinds.push(r[1][i]); parents.push(dir);
      if (o.recursive && r[1][i] === 2) list(dir + "/" + r[0][i], name);
    }
  };
  list(s, "");
  if (o.withFileTypes) {
    const out: Dirent[] = [];
    for (let i = 0; i < names.length; i++) {
      const slash = names[i].lastIndexOf("/");
      out.push(new Dirent(slash < 0 ? names[i] : names[i].slice(slash + 1), kinds[i], parents[i]));
    }
    return out;
  }
  if (o.encoding === null && typeof options === "string" || (typeof options === "object" && options !== null && options.encoding === "buffer")) return names.map((n) => Buffer.from(n));
  return names;
}
export function mkdirSync(p: PathLike, options?: number | string | MkdirOptions): string | undefined {
  const s = pathOf(p);
  let recursive = false;
  let mode = 0o777;
  if (typeof options === "number" || typeof options === "string") mode = modeOf(options, 0o777);
  else if (options !== undefined && options !== null) { recursive = options.recursive === true; mode = modeOf(options.mode, 0o777); }
  if (!recursive) {
    if (!host.mkdir(s, false, mode)) throw fail("mkdir", s);
    return undefined;
  }
  // the first directory created, as Node reports it
  let first: string | undefined = undefined;
  let cur = resolve(s);
  while (cur !== "/" && cur !== "." && !host.access(cur, 0)) { first = cur; cur = dirname(cur); }
  if (first === undefined) {
    const st = host.stat(s, true);
    if (st !== undefined && (st[3] & constants.S_IFMT) === constants.S_IFDIR) return undefined;
    if (st !== undefined) { throw systemError("EEXIST", -17, "mkdir", s); }
  }
  if (!host.mkdir(s, true, mode)) throw fail("mkdir", s);
  return first;
}
export function rmdirSync(p: PathLike, options?: RmOptions): void {
  const s = pathOf(p);
  if (options !== undefined && options.recursive) { rmSync(s, { recursive: true, force: true }); return; }
  if (!host.rmdir(s)) throw fail("rmdir", s);
}
function removeTree(s: string): void {
  const st = host.stat(s, false);
  if (st === undefined) throw fail("lstat", s);
  if ((st[3] & constants.S_IFMT) === constants.S_IFDIR) {
    const r = host.readdir(s);
    if (r === undefined) throw fail("scandir", s);
    for (const name of r[0]) removeTree(s + "/" + name);
    if (!host.rmdir(s)) throw fail("rmdir", s);
  } else if (!host.unlink(s)) throw fail("unlink", s);
}
export function rmSync(p: PathLike, options?: RmOptions): void {
  const s = pathOf(p);
  const st = host.stat(s, false);
  if (st === undefined) {
    if (options !== undefined && options.force && host.lastError() === "ENOENT") return;
    throw fail("lstat", s);
  }
  if ((st[3] & constants.S_IFMT) === constants.S_IFDIR) {
    if (options === undefined || !options.recursive) throw new SystemError("ERR_FS_EISDIR", "EISDIR", 21, "rm", "Path is a directory", s);
    removeTree(s);
  } else if (!host.unlink(s)) throw fail("unlink", s);
}
export function unlinkSync(p: PathLike): void { const s = pathOf(p); if (!host.unlink(s)) throw fail("unlink", s); }
export function renameSync(oldPath: PathLike, newPath: PathLike): void {
  const a = pathOf(oldPath, "oldPath"), b = pathOf(newPath, "newPath");
  if (!host.rename(a, b)) throw fail("rename", a, b);
}
export function linkSync(existing: PathLike, newPath: PathLike): void {
  const a = pathOf(existing, "existingPath"), b = pathOf(newPath, "newPath");
  if (!host.link(a, b)) throw fail("link", a, b);
}
export function symlinkSync(target: PathLike, p: PathLike, _type?: string | null): void {
  const t = pathOf(target, "target"), s = pathOf(p);
  if (!host.symlink(t, s)) throw fail("symlink", t, s);
}
export function readlinkSync(p: PathLike, options?: string | { encoding?: string | null }): string | Buffer {
  const s = pathOf(p);
  const r = host.readlink(s);
  if (r === undefined) throw fail("readlink", s);
  const o = encodingArg(options);
  return o.encoding === null && options !== undefined && options !== null && (options === "buffer" || (typeof options === "object" && options.encoding === "buffer")) ? Buffer.from(r) : r;
}
function realpathImpl(syscall: string): (p: PathLike, options?: string | { encoding?: string | null }) => string {
  return (p: PathLike, _options?: string | { encoding?: string | null }): string => {
    const s = pathOf(p);
    const r = host.realpath(s);
    if (r === undefined) throw fail(syscall, s);
    return r;
  };
}
type RealpathSync = ((p: PathLike, options?: string | { encoding?: string | null }) => string) & { native: (p: PathLike, options?: string | { encoding?: string | null }) => string };
export const realpathSync: RealpathSync = realpathImpl("lstat") as RealpathSync;
realpathSync.native = realpathImpl("realpath");
export function chmodSync(p: PathLike, mode: number | string): void {
  const s = pathOf(p);
  if (!host.chmod(s, modeOf(mode, 0))) throw fail("chmod", s);
}
function timeMs(t: number | string | Date, name: string): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") { if (t !== t) throw invalidArgType(name, "of type number or string or an instance of Date", t); return t * 1000; }
  if (typeof t === "string") { const n = Number(t); if (n !== n) throw invalidArgType(name, "of type number or string or an instance of Date", t); return n * 1000; }
  throw invalidArgType(name, "of type number or string or an instance of Date", t);
}
export function utimesSync(p: PathLike, atime: number | string | Date, mtime: number | string | Date): void {
  const s = pathOf(p);
  if (!host.utimes(s, timeMs(atime, "atime"), timeMs(mtime, "mtime"))) throw fail("utime", s);
}
const TEMP_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export function mkdtempSync(prefix: string, _options?: string | { encoding?: string | null }): string {
  if (typeof prefix !== "string") throw invalidArgType("prefix", "of type string", prefix);
  for (let attempt = 0; attempt < 100; attempt++) {
    const r = host.randomBytes(6);
    let name = prefix;
    for (let i = 0; i < 6; i++) name += TEMP_CHARS[r[i] % TEMP_CHARS.length];
    if (host.mkdir(name, false, 0o700)) return name;
    if (host.lastError() !== "EEXIST") throw fail("mkdtemp", prefix + "XXXXXX");
  }
  throw systemError("EEXIST", -17, "mkdtemp", prefix + "XXXXXX");
}

// ---- descriptors ----
export function openSync(p: PathLike, flags: string | number = "r", mode: number | string = 0o666): number {
  const s = pathOf(p);
  const f = typeof flags === "number" ? flagsFromNumber(flags) : flags;
  const fd = host.open(s, f, modeOf(mode, 0o666));
  if (fd < 0) throw fail("open", s);
  return fd;
}
function flagsFromNumber(n: number): string {
  const acc = n & 3;
  const creat = (n & constants.O_CREAT) !== 0, excl = (n & constants.O_EXCL) !== 0, trunc = (n & constants.O_TRUNC) !== 0, app = (n & constants.O_APPEND) !== 0;
  if (acc === 0) return "r";
  if (app) return (acc === 2 ? "a+" : "a") + (excl ? "x" : "");
  if (creat && trunc) return (acc === 2 ? "w" : "w") + (excl ? "x" : "") + (acc === 2 ? "+" : "");
  return acc === 2 ? "r+" : "w";
}
export function closeSync(fd: number): void { if (!host.close(fd)) throw fail("close"); }
export function fsyncSync(fd: number): void { if (!host.fsync(fd)) throw fail("fsync"); }
export function fdatasyncSync(fd: number): void { fsyncSync(fd); }
export interface ReadSyncOptions { offset?: number; length?: number; position?: number | null }
export function readSync(fd: number, buffer: Uint8Array, offsetOrOptions?: number | ReadSyncOptions, length?: number, position?: number | null): number {
  if (!(buffer instanceof Uint8Array)) throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
  let off = 0, len = buffer.length, pos: number | null = null;
  if (typeof offsetOrOptions === "object" && offsetOrOptions !== null) {
    off = offsetOrOptions.offset === undefined ? 0 : offsetOrOptions.offset;
    len = offsetOrOptions.length === undefined ? buffer.length - off : offsetOrOptions.length;
    pos = offsetOrOptions.position === undefined ? null : offsetOrOptions.position;
  } else {
    if (offsetOrOptions !== undefined) off = offsetOrOptions;
    if (length !== undefined) len = length; else len = buffer.length - off;
    if (position !== undefined) pos = position;
  }
  if (off < 0 || off > buffer.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"offset\" is out of range. It must be >= 0 && <= " + buffer.length + ". Received " + off);
  if (len < 0 || off + len > buffer.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"length\" is out of range. It must be >= 0 && <= " + (buffer.length - off) + ". Received " + len);
  if (len === 0) return 0;
  const n = host.read(fd, buffer, off, len, pos === null ? -1 : pos);
  if (n < 0) throw fail("read");
  return n;
}
export function writeSync(fd: number, data: Uint8Array | string, offsetOrPosition?: number | null, lengthOrEncoding?: number | string | null, position?: number | null): number {
  let n: number;
  if (typeof data === "string") {
    const pos = typeof offsetOrPosition === "number" ? offsetOrPosition : -1;
    const enc = typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8";
    const bytes: string | Uint8Array = normalizeEncoding(enc) === "utf8" ? data : Buffer.from(data, enc);
    n = host.write(fd, bytes, 0, typeof bytes === "string" ? host.utf8Length(bytes) : bytes.length, pos);
  } else {
    if (!(data instanceof Uint8Array)) throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", data);
    const off = typeof offsetOrPosition === "number" ? offsetOrPosition : 0;
    const len = typeof lengthOrEncoding === "number" ? lengthOrEncoding : data.length - off;
    if (off < 0 || off > data.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"offset\" is out of range. It must be >= 0 && <= " + data.length + ". Received " + off);
    if (len < 0 || off + len > data.length) throw codedRangeError("ERR_OUT_OF_RANGE", "The value of \"length\" is out of range. It must be >= 0 && <= " + (data.length - off) + ". Received " + len);
    n = host.write(fd, data, off, len, position === undefined || position === null ? -1 : position);
  }
  if (n < 0) throw fail("write");
  return n;
}

// ---- promises ----
const tick = (): Promise<void> => Promise.resolve();
export const promises = {
  constants,
  async readFile(p: PathLike | number, options?: string | ReadOptions | null): Promise<Buffer | string> { await tick(); return readFileSync(p, options); },
  async writeFile(file: PathLike | number, data: string | Uint8Array, options?: string | WriteOptions | null): Promise<void> { await tick(); writeFileSync(file, data, options); },
  async appendFile(file: PathLike | number, data: string | Uint8Array, options?: string | WriteOptions | null): Promise<void> { await tick(); appendFileSync(file, data, options); },
  async stat(p: PathLike, options?: StatOptions): Promise<Stats> { await tick(); return statSync(p, options) as Stats; },
  async lstat(p: PathLike, options?: StatOptions): Promise<Stats> { await tick(); return lstatSync(p, options) as Stats; },
  async readdir(p: PathLike, options?: string | ReaddirOptions | null): Promise<string[] | Dirent[] | Buffer[]> { await tick(); return readdirSync(p, options); },
  async mkdir(p: PathLike, options?: number | string | MkdirOptions): Promise<string | undefined> { await tick(); return mkdirSync(p, options); },
  async mkdtemp(prefix: string, options?: string | { encoding?: string | null }): Promise<string> { await tick(); return mkdtempSync(prefix, options); },
  async rm(p: PathLike, options?: RmOptions): Promise<void> { await tick(); rmSync(p, options); },
  async rmdir(p: PathLike, options?: RmOptions): Promise<void> { await tick(); rmdirSync(p, options); },
  async unlink(p: PathLike): Promise<void> { await tick(); unlinkSync(p); },
  async rename(a: PathLike, b: PathLike): Promise<void> { await tick(); renameSync(a, b); },
  async copyFile(src: PathLike, dest: PathLike, mode?: number): Promise<void> { await tick(); copyFileSync(src, dest, mode); },
  async access(p: PathLike, mode?: number): Promise<void> { await tick(); accessSync(p, mode); },
  async chmod(p: PathLike, mode: number | string): Promise<void> { await tick(); chmodSync(p, mode); },
  async utimes(p: PathLike, atime: number | string | Date, mtime: number | string | Date): Promise<void> { await tick(); utimesSync(p, atime, mtime); },
  async realpath(p: PathLike, options?: string | { encoding?: string | null }): Promise<string> { await tick(); return realpathSync(p, options); },
  async readlink(p: PathLike, options?: string | { encoding?: string | null }): Promise<string | Buffer> { await tick(); return readlinkSync(p, options); },
  async symlink(target: PathLike, p: PathLike, type?: string | null): Promise<void> { await tick(); symlinkSync(target, p, type); },
  async link(a: PathLike, b: PathLike): Promise<void> { await tick(); linkSync(a, b); },
  async truncate(p: PathLike, len?: number): Promise<void> { await tick(); truncateSync(p, len); },
};

// ---- callbacks ----
function defer<T>(cb: unknown, op: () => T): void {
  if (typeof cb !== "function") throw invalidArgType("cb", "of type function", cb);
  const callback = cb as Callback<T>;
  Promise.resolve().then(() => {
    let value: T;
    try { value = op(); } catch (e) { callback(e as NodeJS_ErrnoException, undefined as unknown as T); return; }
    callback(null, value);
  });
}
function optArgs<O>(options: O | unknown, cb: unknown): [O | undefined, unknown] {
  return typeof options === "function" ? [undefined, options] : [options as O, cb];
}
export function readFile(p: PathLike | number, options: string | ReadOptions | null | Callback<Buffer | string>, cb?: Callback<Buffer | string>): void {
  const [o, c] = optArgs<string | ReadOptions | null>(options, cb); defer(c, () => readFileSync(p, o));
}
export function writeFile(file: PathLike | number, data: string | Uint8Array, options: string | WriteOptions | null | Callback<void>, cb?: Callback<void>): void {
  const [o, c] = optArgs<string | WriteOptions | null>(options, cb); defer(c, () => writeFileSync(file, data, o));
}
export function appendFile(file: PathLike | number, data: string | Uint8Array, options: string | WriteOptions | null | Callback<void>, cb?: Callback<void>): void {
  const [o, c] = optArgs<string | WriteOptions | null>(options, cb); defer(c, () => appendFileSync(file, data, o));
}
export function stat(p: PathLike, options: StatOptions | Callback<Stats>, cb?: Callback<Stats>): void { const [o, c] = optArgs<StatOptions>(options, cb); defer(c, () => statSync(p, o) as Stats); }
export function lstat(p: PathLike, options: StatOptions | Callback<Stats>, cb?: Callback<Stats>): void { const [o, c] = optArgs<StatOptions>(options, cb); defer(c, () => lstatSync(p, o) as Stats); }
export function fstat(fd: number, cb: Callback<Stats>): void { defer(cb, () => fstatSync(fd)); }
export function readdir(p: PathLike, options: string | ReaddirOptions | null | Callback<string[] | Dirent[] | Buffer[]>, cb?: Callback<string[] | Dirent[] | Buffer[]>): void {
  const [o, c] = optArgs<string | ReaddirOptions | null>(options, cb); defer(c, () => readdirSync(p, o));
}
export function mkdir(p: PathLike, options: number | string | MkdirOptions | Callback<string | undefined>, cb?: Callback<string | undefined>): void {
  const [o, c] = optArgs<number | string | MkdirOptions>(options, cb); defer(c, () => mkdirSync(p, o));
}
export function mkdtemp(prefix: string, options: string | { encoding?: string | null } | Callback<string>, cb?: Callback<string>): void {
  const [o, c] = optArgs<string | { encoding?: string | null }>(options, cb); defer(c, () => mkdtempSync(prefix, o));
}
export function rm(p: PathLike, options: RmOptions | Callback<void>, cb?: Callback<void>): void { const [o, c] = optArgs<RmOptions>(options, cb); defer(c, () => rmSync(p, o)); }
export function rmdir(p: PathLike, options: RmOptions | Callback<void>, cb?: Callback<void>): void { const [o, c] = optArgs<RmOptions>(options, cb); defer(c, () => rmdirSync(p, o)); }
export function unlink(p: PathLike, cb: Callback<void>): void { defer(cb, () => unlinkSync(p)); }
export function rename(a: PathLike, b: PathLike, cb: Callback<void>): void { defer(cb, () => renameSync(a, b)); }
export function copyFile(src: PathLike, dest: PathLike, mode: number | Callback<void>, cb?: Callback<void>): void { const [m, c] = optArgs<number>(mode, cb); defer(c, () => copyFileSync(src, dest, m)); }
export function access(p: PathLike, mode: number | Callback<void>, cb?: Callback<void>): void { const [m, c] = optArgs<number>(mode, cb); defer(c, () => accessSync(p, m)); }
export function exists(p: PathLike, cb: (exists: boolean) => void): void {
  if (typeof cb !== "function") throw invalidArgType("cb", "of type function", cb);
  Promise.resolve().then(() => cb(existsSync(p)));
}
export function chmod(p: PathLike, mode: number | string, cb: Callback<void>): void { defer(cb, () => chmodSync(p, mode)); }
export function utimes(p: PathLike, atime: number | string | Date, mtime: number | string | Date, cb: Callback<void>): void { defer(cb, () => utimesSync(p, atime, mtime)); }
export function realpath(p: PathLike, options: string | { encoding?: string | null } | Callback<string>, cb?: Callback<string>): void {
  const [o, c] = optArgs<string | { encoding?: string | null }>(options, cb); defer(c, () => realpathSync(p, o));
}
export function readlink(p: PathLike, options: string | { encoding?: string | null } | Callback<string | Buffer>, cb?: Callback<string | Buffer>): void {
  const [o, c] = optArgs<string | { encoding?: string | null }>(options, cb); defer(c, () => readlinkSync(p, o));
}
export function symlink(target: PathLike, p: PathLike, type: string | null | Callback<void>, cb?: Callback<void>): void { const [t, c] = optArgs<string | null>(type, cb); defer(c, () => symlinkSync(target, p, t)); }
export function link(a: PathLike, b: PathLike, cb: Callback<void>): void { defer(cb, () => linkSync(a, b)); }
export function truncate(p: PathLike, len: number | Callback<void>, cb?: Callback<void>): void { const [l, c] = optArgs<number>(len, cb); defer(c, () => truncateSync(p, l)); }
export function ftruncate(fd: number, len: number | Callback<void>, cb?: Callback<void>): void { const [l, c] = optArgs<number>(len, cb); defer(c, () => ftruncateSync(fd, l)); }
export function open(p: PathLike, flags: string | number | Callback<number>, mode?: number | string | Callback<number>, cb?: Callback<number>): void {
  let f: string | number = "r", m: number | string = 0o666, c: unknown = cb;
  if (typeof flags === "function") c = flags; else { f = flags; if (typeof mode === "function") c = mode; else if (mode !== undefined) m = mode; }
  defer(c, () => openSync(p, f, m));
}
export function close(fd: number, cb?: Callback<void>): void { defer(cb === undefined ? () => {} : cb, () => closeSync(fd)); }
export function fsync(fd: number, cb: Callback<void>): void { defer(cb, () => fsyncSync(fd)); }
export function read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: (err: NodeJS_ErrnoException | null, bytesRead: number, buffer: Uint8Array) => void): void {
  if (typeof cb !== "function") throw invalidArgType("cb", "of type function", cb);
  Promise.resolve().then(() => {
    let n: number;
    try { n = readSync(fd, buffer, offset, length, position); } catch (e) { cb(e as NodeJS_ErrnoException, 0, buffer); return; }
    cb(null, n, buffer);
  });
}
export function write(fd: number, data: Uint8Array | string, ...rest: unknown[]): void {
  const cb = rest.pop() as (err: NodeJS_ErrnoException | null, written: number, data: Uint8Array | string) => void;
  if (typeof cb !== "function") throw invalidArgType("cb", "of type function", cb);
  Promise.resolve().then(() => {
    let n: number;
    try { n = writeSync(fd, data, rest[0] as number | undefined, rest[1] as number | string | undefined, rest[2] as number | undefined); } catch (e) { cb(e as NodeJS_ErrnoException, 0, data); return; }
    cb(null, n, data);
  });
}

const fs = {
  constants, Stats, Dirent, promises,
  statSync, lstatSync, fstatSync, existsSync, accessSync, readFileSync, writeFileSync, appendFileSync, truncateSync, ftruncateSync, copyFileSync,
  readdirSync, mkdirSync, rmdirSync, rmSync, unlinkSync, renameSync, linkSync, symlinkSync, readlinkSync, realpathSync, chmodSync, utimesSync, mkdtempSync,
  openSync, closeSync, fsyncSync, fdatasyncSync, readSync, writeSync,
  readFile, writeFile, appendFile, stat, lstat, fstat, readdir, mkdir, mkdtemp, rm, rmdir, unlink, rename, copyFile, access, exists, chmod, utimes, realpath, readlink, symlink, link, truncate, ftruncate, open, close, fsync, read, write,
};
export default fs;
