// node:child_process (docs/node_compat_design.md): spawnSync, execSync and
// execFileSync run a child to completion (the host forks, feeds stdin, collects
// the pipes); spawn, exec and execFile start it and the event loop reads its
// pipes and reaps it: a ChildProcess with stdin/stdout/stderr streams, kill,
// 'spawn', 'exit', 'close' and 'error'. fork (an IPC channel) is not available.
import { EventEmitter } from "./events";
import { Readable, Writable } from "./stream";
import { Buffer, fromView, BufferEncoding } from "./buffer";
import { host } from "./host";
import { codedError, codedTypeError, codedRangeError, invalidArgType, systemError, uvMessage, validateString } from "./errors";
import process, { SIGNALS } from "./process";
import { promisify } from "./util";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type StdioOption = "pipe" | "inherit" | "ignore" | "overlapped" | number | null | undefined;
export type StdioOptions = "pipe" | "inherit" | "ignore" | "overlapped" | StdioOption[];
export interface CommonOptions {
  cwd?: string | URL;
  env?: { [name: string]: string | undefined };
  argv0?: string;
  stdio?: StdioOptions;
  shell?: boolean | string;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  timeout?: number;
  killSignal?: string | number;
  uid?: number;
  gid?: number;
}
export interface SpawnOptions extends CommonOptions { detached?: boolean; serialization?: string; signal?: unknown }
export interface SpawnSyncOptions extends CommonOptions { input?: string | Uint8Array; maxBuffer?: number; encoding?: string }
export interface ExecOptions extends CommonOptions { encoding?: string; maxBuffer?: number; signal?: unknown }
export interface SpawnSyncReturns<T> { pid: number; output: (T | null)[]; stdout: T; stderr: T; status: number | null; signal: string | null; error?: Error }
export type ExecCallback = (error: ExecException | null, stdout: string | Buffer, stderr: string | Buffer) => void;
export interface ExecException extends Error { cmd?: string; killed?: boolean; code?: number | string | null; signal?: string | null; stdout?: string | Buffer; stderr?: string | Buffer }

const MAX_BUFFER = 1024 * 1024;
function pathString(value: string | URL | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && typeof (value as URL).pathname === "string" && (value as URL).protocol === "file:") {
    return decodeURIComponent((value as URL).pathname);
  }
  throw invalidArgType(name, "of type string or an instance of URL", value);
}
function envList(env: { [name: string]: string | undefined } | undefined): string[] | undefined {
  const source = env === undefined ? process.env : env;
  if (source === process.env && env === undefined) return undefined;   // the host passes the process environment through
  const out: string[] = [];
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined) continue;
    out.push(key + "=" + String(value));
  }
  return out;
}
function signalNumber(signal: string | number | undefined, fallback: number): number {
  if (signal === undefined) return fallback;
  if (typeof signal === "number") return signal;
  if (typeof signal !== "string") throw invalidArgType("signal", "of type string or number", signal);
  const n = SIGNALS[signal];
  if (n === undefined) throw codedTypeError("ERR_UNKNOWN_SIGNAL", `Unknown signal: ${signal}`);
  return n;
}
function signalName(signal: string | number | undefined): string {
  if (typeof signal === "string") return signal;
  if (typeof signal === "number") for (const name of Object.keys(SIGNALS)) if (SIGNALS[name] === signal) return name;
  return "SIGTERM";
}
/** The command line: through the shell when asked ("/bin/sh -c"), else the file and its arguments. */
function commandLine(file: string, args: string[], shell: boolean | string | undefined): string[] {
  if (shell === undefined || shell === false) return [file, ...args];
  const command = [file, ...args].join(" ");
  const sh = typeof shell === "string" ? shell : "/bin/sh";
  return [sh, "-c", command];
}
function stdioModes(stdio: StdioOptions | undefined): [number, number, number] {
  const modeOf = (option: StdioOption, index: number): number => {
    if (option === undefined || option === null || option === "pipe" || option === "overlapped") return 0;
    if (option === "inherit") return 1;
    if (option === "ignore") return 2;
    if (typeof option === "number") return option === index ? 1 : 1;
    throw invalidArgType(`stdio[${index}]`, "one of 'pipe', 'inherit', 'ignore' or a file descriptor", option);
  };
  if (stdio === undefined) return [0, 0, 0];
  if (typeof stdio === "string") { const m = modeOf(stdio, 0); return [m, m, m]; }
  if (!Array.isArray(stdio)) throw invalidArgType("stdio", "one of type string or Array", stdio);
  return [modeOf(stdio[0], 0), modeOf(stdio[1], 1), modeOf(stdio[2], 2)];
}
function spawnError(code: string, syscall: string, file: string, args: string[]): Error & { errno: number; code: string; syscall: string; path: string; spawnargs: string[] } {
  const errno = host.lastErrno();
  const e = systemError(code, -Math.abs(errno), syscall, file) as Error & { errno: number; code: string; syscall: string; path: string; spawnargs: string[] };
  e.message = `${syscall} ${code}`;   // the syscall names the file: "spawn file ENOENT"
  e.spawnargs = args;
  return e;
}
function decodeOutput(bytes: Uint8Array, encoding: string | undefined): string | Buffer {
  const buffer = fromView(bytes);
  if (encoding === undefined || encoding === "buffer") return buffer;
  return buffer.toString(encoding);
}
function normalizeArgs(args: unknown, options: unknown): { args: string[]; options: any } {
  if (Array.isArray(args)) return { args: args.map((a) => String(a)), options: options === undefined || options === null ? {} : options };
  if (args !== undefined && args !== null && typeof args === "object") return { args: [], options: args };
  if (args === undefined || args === null) return { args: [], options: options === undefined || options === null ? {} : options };
  throw invalidArgType("args", "of type object", args);
}

// ---- synchronous ----
export function spawnSync(file: string, args: string[], options: SpawnSyncOptions & { encoding: BufferEncoding }): SpawnSyncReturns<string>;
export function spawnSync(file: string, options: SpawnSyncOptions & { encoding: BufferEncoding }): SpawnSyncReturns<string>;
export function spawnSync(file: string, args?: string[], options?: SpawnSyncOptions & { encoding?: "buffer" | null }): SpawnSyncReturns<Buffer>;
export function spawnSync(file: string, options?: SpawnSyncOptions & { encoding?: "buffer" | null }): SpawnSyncReturns<Buffer>;
export function spawnSync(file: string, args?: string[] | SpawnSyncOptions, options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer>;
export function spawnSync(file: string, args?: string[] | SpawnSyncOptions, options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> {
  validateString(file, "file");
  const n = normalizeArgs(args, options);
  const opts: SpawnSyncOptions = n.options;
  const argv = commandLine(file, n.args, opts.shell);
  const [inMode, outMode, errMode] = stdioModes(opts.stdio);
  let input: string | Uint8Array | number = inMode;
  if (opts.input !== undefined && opts.input !== null) {
    if (typeof opts.input !== "string" && !(opts.input instanceof Uint8Array)) throw invalidArgType("options.input", "of type string or an instance of Buffer, TypedArray, or DataView", opts.input);
    input = opts.input;
  } else if (inMode === 0) input = 2;   // a pipe nothing is written to: the child reads end of file
  const timeout = opts.timeout === undefined ? 0 : opts.timeout;
  if (typeof timeout !== "number" || timeout < 0) throw codedRangeError("ERR_OUT_OF_RANGE", `The value of "options.timeout" is out of range. It must be an unsigned integer. Received ${timeout}`);
  const killSignal = signalNumber(opts.killSignal, 15);
  const result = host.spawnSync(argv, pathString(opts.cwd, "options.cwd"), envList(opts.env), input, timeout, killSignal, outMode, errMode);
  const [status, signal, outBytes, errBytes, errorCode, pid] = result;
  const stdout = outMode === 0 ? decodeOutput(outBytes, opts.encoding) : null;
  const stderr = errMode === 0 ? decodeOutput(errBytes, opts.encoding) : null;
  const ret: SpawnSyncReturns<string | Buffer> = {
    pid,
    output: [null, stdout, stderr],
    stdout: stdout as string | Buffer,
    stderr: stderr as string | Buffer,
    status,
    signal: signal === undefined ? null : signal,
  };
  if (errorCode !== undefined) {
    if (errorCode === "ETIMEDOUT") {
      const e = systemError("ETIMEDOUT", -60, "spawnSync " + file) as unknown as Error & { spawnargs: string[]; path: string };
      e.message = `spawnSync ${file} ETIMEDOUT`;
      e.path = file;
      e.spawnargs = n.args;
      ret.error = e;
    } else ret.error = spawnError(errorCode, "spawnSync " + file, file, n.args);
  }
  const maxBuffer = opts.maxBuffer === undefined ? MAX_BUFFER : opts.maxBuffer;
  if (ret.error === undefined && ((stdout !== null && stdout.length > maxBuffer) || (stderr !== null && stderr.length > maxBuffer))) {
    const e = codedRangeError("ENOBUFS", `spawnSync ${file} ENOBUFS`) as unknown as Error & { errno: number; syscall: string; path: string; spawnargs: string[] };
    e.errno = -105; e.syscall = "spawnSync " + file; e.path = file; e.spawnargs = n.args;
    ret.error = e;
  }
  return ret;
}
function checkExecSyncError(ret: SpawnSyncReturns<string | Buffer>, args: string[], cmd?: string): Error | undefined {
  let err: (Error & { [key: string]: unknown }) | undefined;
  if (ret.error !== undefined) err = ret.error as Error & { [key: string]: unknown };
  else if (ret.status !== 0) {
    let message = "Command failed: ";
    message += cmd !== undefined ? cmd : args.join(" ");
    if (ret.stderr !== null && ret.stderr !== undefined && ret.stderr.length > 0) message += `\n${ret.stderr.toString()}`;
    err = new Error(message) as Error & { [key: string]: unknown };
  }
  if (err !== undefined) {
    err.status = ret.status; err.signal = ret.signal; err.output = ret.output; err.pid = ret.pid; err.stdout = ret.stdout; err.stderr = ret.stderr;
  }
  return err;
}
export function execFileSync(file: string, args: string[], options: SpawnSyncOptions & { encoding: BufferEncoding }): string;
export function execFileSync(file: string, options: SpawnSyncOptions & { encoding: BufferEncoding }): string;
export function execFileSync(file: string, args?: string[], options?: SpawnSyncOptions & { encoding?: "buffer" | null }): Buffer;
export function execFileSync(file: string, options?: SpawnSyncOptions & { encoding?: "buffer" | null }): Buffer;
export function execFileSync(file: string, args?: string[] | SpawnSyncOptions, options?: SpawnSyncOptions): string | Buffer;
export function execFileSync(file: string, args?: string[] | SpawnSyncOptions, options?: SpawnSyncOptions): string | Buffer {
  const n = normalizeArgs(args, options);
  const opts: SpawnSyncOptions = { ...n.options };
  if (opts.stdio === undefined) opts.stdio = ["pipe", "pipe", "inherit"];
  const ret = spawnSync(file, n.args, opts);
  const err = checkExecSyncError(ret, [file, ...n.args]);
  if (err !== undefined) throw err;
  return ret.stdout;
}
export function execSync(command: string, options: SpawnSyncOptions & { encoding: BufferEncoding }): string;
export function execSync(command: string, options?: SpawnSyncOptions & { encoding?: "buffer" | null }): Buffer;
export function execSync(command: string, options?: SpawnSyncOptions): string | Buffer;
export function execSync(command: string, options?: SpawnSyncOptions): string | Buffer {
  validateString(command, "command");
  const opts: SpawnSyncOptions = { ...(options === undefined || options === null ? {} : options) };
  if (opts.stdio === undefined) opts.stdio = ["pipe", "pipe", "inherit"];
  const shell = opts.shell === undefined || opts.shell === false ? true : opts.shell;
  const ret = spawnSync(command, [], { ...opts, shell });
  const err = checkExecSyncError(ret, [], command);
  if (err !== undefined) throw err;
  return ret.stdout;
}

// ---- asynchronous ----
export class ChildProcess extends EventEmitter {
  pid: number | undefined = undefined;
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  stdio: [Writable | null, Readable | null, Readable | null] = [null, null, null];
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed: boolean = false;
  connected: boolean = false;
  spawnfile: string = "";
  spawnargs: string[] = [];
  private exited = false;
  private streamsOpen = 0;
  private closeEmitted = false;
  /** @internal */
  start(file: string, args: string[], options: SpawnOptions): void {
    this.spawnfile = file;
    this.spawnargs = [file, ...args];
    const argv = commandLine(file, args, options.shell);
    const [inMode, outMode, errMode] = stdioModes(options.stdio);
    const result = host.spawn(argv, pathString(options.cwd, "options.cwd"), envList(options.env), inMode, outMode, errMode);
    if (typeof result === "string") {
      const err = spawnError(result, "spawn " + file, file, args);
      this.exitCode = -Math.abs(host.lastErrno());
      host.nextTick(() => {
        this.emit("error", err);
        this.maybeClose();
      }, undefined);
      return;
    }
    const [pid, inFd, outFd, errFd] = result;
    this.pid = pid;
    if (inFd >= 0) {
      let open = true;
      this.stdin = new Writable({
        write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
          let offset = 0;
          while (offset < chunk.length) {
            const n = host.write(inFd, chunk, offset, chunk.length - offset);
            if (n < 0) { callback(systemError("EPIPE", -32, "write")); return; }
            offset += n;
          }
          callback();
        },
        final(callback: (error?: Error | null) => void): void { if (open) { open = false; host.close(inFd); } callback(); },
        destroy(error: Error | null, callback: (error?: Error | null) => void): void { if (open) { open = false; host.close(inFd); } callback(error); },
      });
    }
    const pipeReader = (fd: number): Readable => {
      let watch: number | null = null;
      const readable = new Readable({
        read(): void {
          if (watch !== null) return;
          watch = host.watchFd(fd,
            (bytes) => { if (!readable.push(fromView(bytes))) { if (watch !== null) { host.unwatchFd(watch); watch = null; } } },
            () => { watch = null; readable.push(null); });
        },
        destroy: (error: Error | null, callback: (error?: Error | null) => void): void => {
          if (watch !== null) { host.unwatchFd(watch); watch = null; }
          callback(error);
        },
      });
      this.streamsOpen++;
      readable.on("close", () => { this.streamsOpen--; this.maybeClose(); });
      return readable;
    };
    if (outFd >= 0) this.stdout = pipeReader(outFd);
    if (errFd >= 0) this.stderr = pipeReader(errFd);
    this.stdio = [this.stdin, this.stdout, this.stderr];
    host.onChildExit(pid, (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.signalCode = signal;
      if (this.stdin !== null && !this.stdin.destroyed) this.stdin.destroy();
      this.emit("exit", code, signal);
      // a pipe nobody reads is drained to its end so that it closes (Node's flushStdio)
      for (const stream of [this.stdout, this.stderr]) {
        if (stream !== null && !stream.readableEnded && !stream.destroyed && stream.readableFlowing === null) stream.resume();
      }
      this.maybeClose();
    });
    host.nextTick(() => this.emit("spawn"), undefined);
  }
  private maybeClose(): void {
    if (this.closeEmitted) return;
    if (!this.exited && this.pid !== undefined) return;
    if (this.streamsOpen > 0) return;
    this.closeEmitted = true;
    host.nextTick(() => this.emit("close", this.exitCode, this.signalCode), undefined);
  }
  kill(signal?: string | number): boolean {
    if (this.pid === undefined || this.exited) return false;
    const n = signalNumber(signal, 15);
    if (!host.kill(this.pid, n)) return false;
    if (n !== 0) this.killed = true;
    return true;
  }
  ref(): void {}
  unref(): void {}
  send(): boolean { throw codedError("ERR_IPC_CHANNEL_CLOSED", "Channel closed"); }
  disconnect(): void { throw codedError("ERR_IPC_DISCONNECTED", "IPC channel is already disconnected"); }
}
export function spawn(file: string, args?: string[] | SpawnOptions, options?: SpawnOptions): ChildProcess {
  validateString(file, "file");
  const n = normalizeArgs(args, options);
  const child = new ChildProcess();
  child.start(file, n.args, n.options);
  return child;
}
function execCommon(file: string, args: string[], options: ExecOptions, shellCommand: string | undefined, callback: ExecCallback | undefined): ChildProcess {
  const child = spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const encoding = options.encoding === undefined ? "utf8" : options.encoding;
  const maxBuffer = options.maxBuffer === undefined ? MAX_BUFFER : options.maxBuffer;
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outLength = 0, errLength = 0;
  let exited = false;
  let error: ExecException | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killSignal = options.killSignal === undefined ? "SIGTERM" : options.killSignal;
  const finish = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    const stdout = decodeOutput(Buffer.concat(outChunks, outLength), encoding === "buffer" ? undefined : encoding);
    const stderr = decodeOutput(Buffer.concat(errChunks, errLength), encoding === "buffer" ? undefined : encoding);
    if (callback === undefined) return;
    if (error === null && child.exitCode === 0 && child.signalCode === null) { callback(null, stdout, stderr); return; }
    const cmd = shellCommand !== undefined ? shellCommand : [file, ...args].join(" ");
    if (error === null) {
      let message = "Command failed: " + cmd;
      if (stderr.length > 0) message += "\n" + stderr.toString();
      error = new Error(message) as ExecException;
      error.code = child.exitCode;
      error.killed = child.killed;
      error.signal = child.signalCode;
    }
    error.cmd = cmd;
    error.stdout = stdout;
    error.stderr = stderr;
    callback(error, stdout, stderr);
  };
  const exceeded = (): void => {
    if (error === null) {
      error = codedRangeError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "stdout maxBuffer length exceeded") as ExecException;
      child.kill(killSignal);
    }
  };
  if (child.stdout !== null) child.stdout.on("data", (chunk: Buffer) => { outChunks.push(chunk); outLength += chunk.length; if (outLength > maxBuffer) exceeded(); });
  if (child.stderr !== null) child.stderr.on("data", (chunk: Buffer) => { errChunks.push(chunk); errLength += chunk.length; if (errLength > maxBuffer) exceeded(); });
  child.on("error", (err: Error) => { error = err as ExecException; if (!exited) { exited = true; finish(); } });
  child.on("close", () => { if (!exited) { exited = true; finish(); } });
  if (options.timeout !== undefined && options.timeout > 0) {
    timer = setTimeout(() => { if (!exited) { child.kill(killSignal); const e = new Error("Command failed: " + (shellCommand !== undefined ? shellCommand : [file, ...args].join(" "))) as ExecException; e.killed = true; e.signal = signalName(killSignal); error = e; } }, options.timeout);
  }
  return child;
}
export function execFile(file: string, args?: string[] | ExecOptions | ExecCallback, options?: ExecOptions | ExecCallback, callback?: ExecCallback): ChildProcess {
  validateString(file, "file");
  let argList: string[] = [];
  let opts: ExecOptions = {};
  if (Array.isArray(args)) argList = args.map((a) => String(a));
  else if (typeof args === "function") callback = args;
  else if (args !== undefined && args !== null) opts = args;
  if (typeof options === "function") callback = options;
  else if (options !== undefined && options !== null) opts = options;
  return execCommon(file, argList, opts, undefined, callback);
}
export function exec(command: string, options?: ExecOptions | ExecCallback, callback?: ExecCallback): ChildProcess {
  validateString(command, "command");
  let opts: ExecOptions = {};
  if (typeof options === "function") callback = options;
  else if (options !== undefined && options !== null) opts = options;
  const shell = opts.shell === undefined || opts.shell === false ? true : opts.shell;
  return execCommon(command, [], { ...opts, shell }, command, callback);
}
type ExecPromiseResult = { stdout: string | Buffer; stderr: string | Buffer };
function promisified(run: (callback: ExecCallback) => ChildProcess): Promise<ExecPromiseResult> & { child?: ChildProcess } {
  let child: ChildProcess | undefined;
  const promise = new Promise<ExecPromiseResult>((resolve, reject) => {
    child = run((err, stdout, stderr) => {
      if (err !== null) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  }) as Promise<ExecPromiseResult> & { child?: ChildProcess };
  promise.child = child;
  return promise;
}
(exec as unknown as { [key: symbol]: unknown })[promisify.custom] = (command: string, options?: ExecOptions): Promise<ExecPromiseResult> =>
  promisified((cb) => exec(command, options, cb));
(execFile as unknown as { [key: symbol]: unknown })[promisify.custom] = (file: string, args?: string[] | ExecOptions, options?: ExecOptions): Promise<ExecPromiseResult> =>
  promisified((cb) => (Array.isArray(args) ? execFile(file, args, options, cb) : execFile(file, args as ExecOptions | undefined, cb)));
export function fork(): never {
  throw codedError("ERR_METHOD_NOT_IMPLEMENTED", "child_process.fork (an IPC channel to a Node child) is not available: spawn the program with stdio pipes instead");
}
export { uvMessage };
const child_process = { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, ChildProcess };
export default child_process;
