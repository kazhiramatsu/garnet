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
  readonly platform: string;
  readonly arch: string;
}
declare global {
  var __garnet_node: GarnetNodeHost;
}
export const host: GarnetNodeHost = __garnet_node;
