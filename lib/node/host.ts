// The host primitives garnet's Node modules stand on (runtime/node_host.c,
// docs/node_compat_design.md): thin POSIX calls as the global `__garnet_node`.
// A failing call answers undefined (or false / -1) and leaves its errno for
// lastError(); errors.ts turns that into Node's error objects.
export interface GarnetNodeHost {
  readFile(path: string | number): Uint8Array | undefined;
  writeFile(path: string | number, data: string | Uint8Array, flags?: string, mode?: number): boolean;
  open(path: string, flags: string, mode?: number): number;
  close(fd: number): boolean;
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  write(fd: number, data: string | Uint8Array, offset?: number, length?: number, position?: number): number;
  /** [kind, size, mtimeMs, mode, uid, gid, atimeMs, ctimeMs, birthtimeMs, nlink, dev, ino, blksize, blocks]
   *  (kind: 1 file, 2 directory, 3 link, 4 fifo, 5 socket, 6 character device, 7 block device, 0 other) */
  stat(path: string, follow: boolean): number[] | undefined;
  fstat(fd: number): number[] | undefined;
  readdir(path: string): [string[], number[]] | undefined;
  mkdir(path: string, recursive: boolean, mode?: number): boolean;
  rmdir(path: string): boolean;
  unlink(path: string): boolean;
  rename(from: string, to: string): boolean;
  link(from: string, to: string): boolean;
  symlink(target: string, path: string): boolean;
  readlink(path: string): string | undefined;
  realpath(path: string): string | undefined;
  chmod(path: string, mode: number): boolean;
  utimes(path: string, atimeMs: number, mtimeMs: number): boolean;
  truncate(path: string | number, length: number): boolean;
  access(path: string, mode: number): boolean;
  copyFile(src: string, dest: string, exclusive: boolean): boolean;
  fsync(fd: number): boolean;
  isatty(fd: number): boolean;
  ttySize(fd: number): [number, number] | undefined;
  /** The errno name of the last failed call, and its negated number. */
  lastError(): string;
  lastErrno(): number;
  argv(): string[];
  env(): { [name: string]: string };
  cwd(): string | undefined;
  chdir(path: string): boolean;
  execPath(): string;
  exit(code: number): never;
  pid(): number;
  ppid(): number;
  kill(pid: number, signal: number): boolean;
  umask(mask?: number): number;
  hrtime(): [number, number];
  /** Milliseconds since the program started (monotonic). */
  now(): number;
  timeOrigin(): number;
  rss(): number;
  cpuUsage(): [number, number];
  hostname(): string;
  homedir(): string;
  tmpdir(): string;
  cpus(): number;
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
  uptime(): number;
  /** [sysname, release, version, machine] */
  uname(): [string, string, string, string] | undefined;
  /** [username, uid, gid, shell, homedir] */
  userInfo(): [string, number, number, string, string];
  utf8Length(text: string): number;
  randomBytes(count: number): Uint8Array;
  /** The bytes of `text` written into `view` at `offset`, at most `max`: kind 0 UTF-8 (whole characters),
   *  1 UTF-16LE (whole units), 2 Latin-1 (the low byte of each unit). Returns the count written. */
  writeString(text: string, view: Uint8Array, offset: number, max: number, kind: number): number;
  /** Object.create for a library object: a prototype chain that reaches a class with fields is a TypeError. */
  createObject(proto: object | null): object;
  /** Object.setPrototypeOf for a library object: a class instance, a class prototype or a chain to a class with fields is a TypeError. */
  relink(obj: object, proto: object | null): void;
  /** The digest of `data` by "md5", "sha1", "sha256" or "sha512"; undefined for another name. */
  hash(algorithm: string, data: string | Uint8Array): Uint8Array | undefined;
  /** Runs argv[0] with argv to completion. stdin: bytes to feed, or 1 (inherit) or 2 (ignore);
   *  stdout/stderr modes: 0 pipe (collected), 1 inherit, 2 ignore. Returns
   *  [status | null, signal | undefined, stdout, stderr, errorCode | undefined, pid]. */
  spawnSync(argv: string[], cwd: string | undefined, env: string[] | undefined, stdin: string | Uint8Array | number,
            timeoutMs: number, killSignal: string | number, stdoutMode: number, stderrMode: number): [number | null, string | undefined, Uint8Array, Uint8Array, string | undefined, number];
  /** Starts argv[0]; modes 0 pipe, 1 inherit, 2 ignore. Returns [pid, stdinFd, stdoutFd, stderrFd] (-1 for a
   *  stream not piped) or the error code as a string. */
  spawn(argv: string[], cwd: string | undefined, env: string[] | undefined, stdinMode: number, stdoutMode: number, stderrMode: number): [number, number, number, number] | string;
  /** The callback runs from the event loop when the child exits: (code | null, signal | null). */
  onChildExit(pid: number, callback: (code: number | null, signal: string | null) => void): boolean;
  /** The loop reads `fd` as data arrives: onData(bytes) per chunk, onEnd() at end of file (the fd is closed). */
  watchFd(fd: number, onData: (bytes: Uint8Array) => void, onEnd: () => void): number;
  unwatchFd(id: number): void;
  /** The text console.log prints for a value. */
  inspect(value: unknown): string;
  /** The hook the loop calls when nothing keeps it alive: phase 0 is 'beforeExit' (the hook
   *  may schedule more work), phase 1 is 'exit' (its number is the exit status). */
  atExit(hook: (phase: number) => number | undefined): void;
  /** A timer: the callback with the arguments after `delayMs` (again every `repeatMs` when > 0); its id. */
  timerAdd(callback: (...args: unknown[]) => void, args: unknown[] | undefined, delayMs: number, repeatMs: number): number;
  timerClear(id: number): void;
  timerRef(id: number, on: boolean): boolean;
  timerHasRef(id: number): boolean;
  timerRefresh(id: number, delayMs: number): boolean;
  immediate(callback: (...args: unknown[]) => void, args: unknown[] | undefined): number;
  immediateClear(id: number): void;
  immediateRef(id: number, on: boolean): boolean;
  immediateHasRef(id: number): boolean;
  nextTick(callback: (...args: unknown[]) => void, args: unknown[] | undefined): void;
  /** node:worker_threads over the fork workers (docs/node_compat_design.md, N5b): whether this
   *  process is a worker, its id (0 in the main thread), and its workerData. */
  isWorker(): boolean;
  threadId(): number;
  workerData(): unknown;
  /** A forked child calls `start(entry, data, id)` instead of the entry: the library makes its
   *  bindings the worker's first (the module's state is the parent's at the fork). */
  setWorkerStart(start: (entry: unknown, data: unknown, id: number) => void): void;
  /** Forks a worker that runs `entry` (a function of the program the exporter names for the
   *  worker's module) with `data` as its workerData; `shared` forks it into a region the parent
   *  reads (garnet:shared). The handlers run from the event loop: a message from the worker, an
   *  uncaught exception of the worker, and its exit code. The worker's id. */
  spawnWorker(entry: unknown, data: unknown, shared: boolean, onMessage: (value: unknown) => void,
              onError: (error: unknown) => void, onExit: (code: number) => void): number;
  sendToWorker(id: number, value: unknown): void;
  /** SIGTERM to the worker; its exit handler then runs with code 1. */
  killWorker(id: number): void;
  /** Whether the live worker keeps the parent's event loop alive. */
  workerRef(id: number, on: boolean): void;
  /** The worker's side: a message to the parent, the parent's messages (registering the
   *  listener keeps the worker alive until the port is closed), and closing the port. */
  postMessage(value: unknown): void;
  onParentMessage(listener: (value: unknown) => void): void;
  closeParentPort(): void;
  readonly platform: string;
  readonly arch: string;
}
declare global {
  var __garnet_node: GarnetNodeHost;
}
export const host: GarnetNodeHost = __garnet_node;
