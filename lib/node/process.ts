// node:process and the `process` global (docs/node_compat_design.md): the
// arguments (execPath twice, then the program's, so argv.slice(2) is them as
// in Node), the environment, the working directory, exit with the 'exit'
// listeners, clocks, memory, standard output and error as writable streams.
import { EventEmitter } from "./events";
import { host } from "./host";
import { lastError, invalidArgType, validateString } from "./errors";
import type { ReadStream } from "./tty";

/** process.stdout and process.stderr: the writable half of a tty.WriteStream as a
 *  structural type, so that the stream (lib/node/tty.ts, compiled when the program names
 *  stdout, stderr or stdin) and the minimal writer used otherwise both fit. */
export interface WriteStream {
  readonly fd: number;
  readonly isTTY: true | undefined;
  readonly writable: boolean;
  columns: number | undefined;
  rows: number | undefined;
  write(chunk: string | Uint8Array, encodingOrCallback?: string | ((error?: Error | null) => void) | null, callback?: (error?: Error | null) => void): boolean;
  end(chunk?: string | Uint8Array | (() => void), encodingOrCallback?: string | (() => void) | null, callback?: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  addListener(event: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
  emit(event: string | symbol, ...args: any[]): boolean;
  cork(): void;
  uncork(): void;
  destroy(error?: Error | null): this;
  getColorDepth(env?: object): number;
  hasColors(count?: number | object, env?: object): boolean;
  getWindowSize(): [number, number];
  cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean;
  moveCursor(dx: number, dy: number, callback?: () => void): boolean;
  clearLine(dir: number, callback?: () => void): boolean;
  clearScreenDown(callback?: () => void): boolean;
}
type StdioFactory = (fd: number) => WriteStream | ReadStream;
let stdioFactory: StdioFactory | null = null;
/** @internal lib/node/tty.ts registers the standard-stream classes when it loads. */
export function _setStdioFactory(factory: StdioFactory): void { stdioFactory = factory; }
/** The standard output streams of a program that never names them: synchronous writes,
 *  the terminal size, no events (nothing is ever emitted). */
function minimalWriter(fd: number): WriteStream {
  const tty = host.isatty(fd);
  const size = tty ? host.ttySize(fd) : undefined;
  const self = {
    fd,
    isTTY: (tty ? true : undefined) as true | undefined,
    writable: true,
    columns: size === undefined ? undefined : size[0],
    rows: size === undefined ? undefined : size[1],
    write(chunk: string | Uint8Array, encodingOrCallback?: string | ((error?: Error | null) => void) | null, callback?: (error?: Error | null) => void): boolean {
      const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw invalidArgType("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
      let error: Error | undefined = undefined;
      const total = typeof chunk === "string" ? host.utf8Length(chunk) : chunk.length;
      let offset = 0;
      while (offset < total) {
        const written = host.write(fd, chunk, offset, total - offset);
        if (written < 0) { error = lastError("write"); break; }
        offset += written;
      }
      if (cb !== undefined) host.nextTick(() => cb(error), undefined);
      else if (error !== undefined) throw error;
      return true;
    },
    end(chunk?: string | Uint8Array | (() => void), encodingOrCallback?: string | (() => void) | null, callback?: () => void): WriteStream {
      if (typeof chunk === "function") callback = chunk;
      else if (chunk !== undefined) self.write(chunk);
      if (typeof encodingOrCallback === "function") callback = encodingOrCallback;
      if (callback !== undefined) host.nextTick(callback, undefined);
      return self;
    },
    on(): WriteStream { return self; },
    once(): WriteStream { return self; },
    off(): WriteStream { return self; },
    addListener(): WriteStream { return self; },
    removeListener(): WriteStream { return self; },
    emit(): boolean { return false; },
    cork(): void {},
    uncork(): void {},
    destroy(): WriteStream { return self; },
    getColorDepth(): number { return tty ? 8 : 1; },
    hasColors(count: number | object = 16): boolean { return tty && (typeof count !== "number" || count <= 256); },
    getWindowSize(): [number, number] { return [self.columns === undefined ? 80 : self.columns, self.rows === undefined ? 24 : self.rows]; },
    cursorTo(x: number, y?: number | (() => void), callback?: () => void): boolean {
      if (typeof y === "function") { callback = y; y = undefined; }
      return self.write(typeof y !== "number" ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`, callback);
    },
    moveCursor(dx: number, dy: number, callback?: () => void): boolean {
      let seq = "";
      if (dx < 0) seq += `\x1b[${-dx}D`; else if (dx > 0) seq += `\x1b[${dx}C`;
      if (dy < 0) seq += `\x1b[${-dy}A`; else if (dy > 0) seq += `\x1b[${dy}B`;
      return self.write(seq, callback);
    },
    clearLine(dir: number, callback?: () => void): boolean { return self.write(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\x1b[2K", callback); },
    clearScreenDown(callback?: () => void): boolean { return self.write("\x1b[0J", callback); },
  };
  return self as unknown as WriteStream;
}

export interface MemoryUsage { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number }
export interface CpuUsage { user: number; system: number }
export interface MemoryUsageFn { (): MemoryUsage; rss(): number }
function memoryUsageImpl(): MemoryUsage { return { rss: host.rss(), heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; }
const memoryUsageFn: MemoryUsageFn = memoryUsageImpl as MemoryUsageFn;
memoryUsageFn.rss = (): number => host.rss();
export type Signal = string;

export class Process extends EventEmitter {
  readonly argv: string[];
  readonly argv0: string;
  readonly execArgv: string[] = [];
  readonly execPath: string;
  readonly env: { [name: string]: string | undefined };
  readonly pid: number;
  readonly ppid: number;
  readonly platform: string;
  readonly arch: string;
  readonly version: string = "v22.12.0";
  readonly versions: { [name: string]: string } = { node: "22.12.0", garnet: "0.1.0" };
  readonly release: { name: string } = { name: "node" };
  private _stdout: WriteStream | null = null;
  private _stderr: WriteStream | null = null;
  private _stdin: ReadStream | null = null;
  /** Standard output: the tty stream when the program names stdout/stderr/stdin, else a minimal writer. */
  get stdout(): WriteStream {
    if (this._stdout === null) this._stdout = stdioFactory !== null ? (stdioFactory(1) as WriteStream) : minimalWriter(1);
    return this._stdout;
  }
  get stderr(): WriteStream {
    if (this._stderr === null) this._stderr = stdioFactory !== null ? (stdioFactory(2) as WriteStream) : minimalWriter(2);
    return this._stderr;
  }
  /** Standard input as a readable stream, created on first use (reading it keeps the process alive). */
  get stdin(): ReadStream {
    if (this._stdin === null) {
      if (stdioFactory === null) throw new Error("process.stdin is not available: the program does not name it, so lib/node/tty.ts was not compiled (name process.stdin, or import \"node:tty\")");
      this._stdin = stdioFactory(0) as ReadStream;
    }
    return this._stdin;
  }
  title: string = "garnet";
  exitCode: number | undefined = undefined;
  private _exiting: boolean = false;
  constructor() {
    super();
    const argv = host.argv();
    this.execPath = host.execPath();
    this.argv = [this.execPath, this.execPath];
    for (let i = 1; i < argv.length; i++) this.argv.push(argv[i]);
    this.argv0 = argv.length > 0 ? argv[0] : this.execPath;
    this.env = host.env();
    this.pid = host.pid();
    this.ppid = host.ppid();
    this.platform = host.platform;
    this.arch = host.arch;
  }
  cwd(): string {
    const dir = host.cwd();
    if (dir === undefined) throw lastError("uv_cwd");
    return dir;
  }
  chdir(directory: string): void {
    validateString(directory, "directory");
    const from = host.cwd();
    if (!host.chdir(directory)) throw lastError("chdir", from, directory);
  }
  /** Emits 'exit' once with the code, then ends the process. */
  exit(code?: number): never {
    const c = code === undefined ? (this.exitCode === undefined ? 0 : this.exitCode) : code;
    if (!this._exiting) {
      this._exiting = true;
      this.exitCode = c;
      this.emit("exit", c);
    }
    return host.exit(this.exitCode === undefined ? c : this.exitCode);
  }
  /** The loop found nothing to do: 'beforeExit' (a listener may schedule more work). */
  _beforeExit(): void {
    if (!this._exiting) this.emit("beforeExit", this.exitCode === undefined ? 0 : this.exitCode);
  }
  /** The program's natural end (the runtime calls it after the event loop): 'exit' once, the status. */
  _atExit(): number {
    const c = this.exitCode === undefined ? 0 : this.exitCode;
    if (!this._exiting) {
      this._exiting = true;
      this.emit("exit", c);
    }
    return this.exitCode === undefined ? c : this.exitCode;
  }
  reallyExit(code: number): never { return host.exit(code); }
  abort(): never { return host.exit(134); }
  hrtime(previous?: [number, number]): [number, number] {
    const now = host.hrtime();
    if (previous === undefined) return now;
    let seconds = now[0] - previous[0];
    let nanoseconds = now[1] - previous[1];
    if (nanoseconds < 0) { seconds--; nanoseconds += 1e9; }
    return [seconds, nanoseconds];
  }
  uptime(): number { return host.now() / 1000; }
  /** process.memoryUsage() and process.memoryUsage.rss(). */
  readonly memoryUsage: MemoryUsageFn = memoryUsageFn;
  /** The CPU time of the thread: the process's, there being one. */
  threadCpuUsage(previous?: CpuUsage): CpuUsage { return this.cpuUsage(previous); }
  constrainedMemory(): number { return 0; }
  availableMemory(): number { return host.freemem(); }
  cpuUsage(previous?: CpuUsage): CpuUsage {
    const u = host.cpuUsage();
    if (previous === undefined) return { user: u[0], system: u[1] };
    return { user: u[0] - previous.user, system: u[1] - previous.system };
  }
  /** Runs `callback` before the promise reactions of the current turn (the loop's tick queue). */
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void {
    if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    host.nextTick(callback, args.length === 0 ? undefined : args);
  }
  emitWarning(warning: string | Error, type?: string | { type?: string; code?: string; detail?: string }, code?: string): void {
    let name = "Warning";
    let detail: string | undefined = undefined;
    if (typeof type === "string") name = type;
    else if (type !== undefined) { if (type.type !== undefined) name = type.type; if (type.code !== undefined) code = type.code; detail = type.detail; }
    const message = typeof warning === "string" ? warning : warning.message;
    if (typeof warning !== "string" && name === "Warning") name = warning.name;
    let line = "(node:" + this.pid + ") " + (code !== undefined ? "[" + code + "] " : "") + name + ": " + message + "\n";
    if (detail !== undefined) line += detail + "\n";
    this.stderr.write(line);
    this.emit("warning", typeof warning === "string" ? new Error(message) : warning);
  }
  kill(pid: number, signal: string | number = "SIGTERM"): true {
    const signum = typeof signal === "number" ? signal : SIGNALS[signal];
    if (signum === undefined) throw new TypeError("Unknown signal: " + signal);
    if (!host.kill(pid, signum)) throw lastError("kill");
    return true;
  }
  umask(mask?: number): number { return host.umask(mask); }
  getuid(): number { return host.userInfo()[1]; }
  geteuid(): number { return host.userInfo()[1]; }
  getgid(): number { return host.userInfo()[2]; }
  getegid(): number { return host.userInfo()[2]; }
  hasUncaughtExceptionCaptureCallback(): boolean { return false; }
}
const darwin = host.platform === "darwin";
export const SIGNALS: { [name: string]: number } = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: darwin ? 10 : 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: darwin ? 30 : 10, SIGSEGV: 11, SIGUSR2: darwin ? 31 : 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: darwin ? 20 : 17, SIGCONT: darwin ? 19 : 18, SIGSTOP: darwin ? 17 : 19, SIGTSTP: darwin ? 18 : 20, SIGWINCH: 28,
};

const process = new Process();
host.atExit((phase: number): number | undefined => { if (phase === 0) { process._beforeExit(); return undefined; } return process._atExit(); });
export default process;
