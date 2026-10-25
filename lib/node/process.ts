// node:process and the `process` global (docs/node_compat_design.md): the
// arguments (execPath twice, then the program's, so argv.slice(2) is them as
// in Node), the environment, the working directory, exit with the 'exit'
// listeners, clocks, memory, standard output and error as writable streams.
import { EventEmitter } from "./events";
import { host } from "./host";
import { lastError, invalidArgType, validateString } from "./errors";

export interface WriteStream {
  readonly fd: number;
  readonly isTTY: boolean;
  readonly writable: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  write(chunk: string | Uint8Array, encodingOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean;
  end(chunk?: string | Uint8Array): void;
  getColorDepth(): number;
  hasColors(): boolean;
}
function makeWriteStream(fd: number): WriteStream {
  const tty = host.isatty(fd);
  const size = tty ? host.ttySize(fd) : undefined;
  return {
    fd,
    isTTY: tty,
    writable: true,
    columns: size === undefined ? undefined : size[0],
    rows: size === undefined ? undefined : size[1],
    write(chunk: string | Uint8Array, encodingOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean {
      const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw invalidArgType("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
      let error: Error | undefined = undefined;
      const total = typeof chunk === "string" ? host.utf8Length(chunk) : chunk.length;
      let offset = 0;
      while (offset < total) {
        const written = host.write(fd, chunk, offset, total - offset);
        if (written < 0) { error = lastError("write"); break; }
        offset += written;
      }
      if (cb !== undefined) Promise.resolve().then(() => cb(error));
      else if (error !== undefined) throw error;
      return true;
    },
    end(chunk?: string | Uint8Array): void { if (chunk !== undefined) this.write(chunk); },
    getColorDepth(): number { return tty ? 8 : 1; },
    hasColors(): boolean { return tty; },
  };
}

export interface MemoryUsage { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number }
export interface CpuUsage { user: number; system: number }
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
  readonly stdout: WriteStream;
  readonly stderr: WriteStream;
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
    this.stdout = makeWriteStream(1);
    this.stderr = makeWriteStream(2);
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
  memoryUsage(): MemoryUsage { return { rss: host.rss(), heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; }
  cpuUsage(previous?: CpuUsage): CpuUsage {
    const u = host.cpuUsage();
    if (previous === undefined) return { user: u[0], system: u[1] };
    return { user: u[0] - previous.user, system: u[1] - previous.system };
  }
  /** Runs `callback` before the next macrotask (as a microtask until the loop's own queue arrives, N3). */
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void {
    if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    Promise.resolve().then(() => { callback(...args); });
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
const SIGNALS: { [name: string]: number } = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: darwin ? 10 : 7, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: darwin ? 30 : 10, SIGSEGV: 11, SIGUSR2: darwin ? 31 : 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  SIGCHLD: darwin ? 20 : 17, SIGCONT: darwin ? 19 : 18, SIGSTOP: darwin ? 17 : 19, SIGTSTP: darwin ? 18 : 20, SIGWINCH: 28,
};

const process = new Process();
host.atExit(() => process._atExit());
export default process;
