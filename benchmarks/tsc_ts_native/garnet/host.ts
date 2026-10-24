// The native host's primitives (benchmarks/tsc_ts_native/host.c).
export interface GarnetHost {
  readFile(path: string): Uint8Array | undefined;
  writeFile(path: string, data: string | Uint8Array): boolean;
  writeFd(fd: number, data: string | Uint8Array, offset?: number, length?: number): number;
  readFd(fd: number, buffer: Uint8Array, offset: number, length: number): number;
  /** [kind (1 file, 2 directory, 3 link, 0 other), size, mtimeMs] */
  stat(path: string, follow: boolean): [number, number, number] | undefined;
  readdir(path: string): [string[], number[]] | undefined;
  mkdir(path: string, recursive: boolean): boolean;
  realpath(path: string): string | undefined;
  unlink(path: string): boolean;
  utimes(path: string, atimeMs: number, mtimeMs: number): boolean;
  /** The errno name of the last failed call. */
  lastError(): string;
  cwd(): string;
  env(): { [name: string]: string };
  argv(): string[];
  execPath(): string;
  exit(code: number): never;
  isatty(fd: number): boolean;
  pid(): number;
  ppid(): number;
  hrtime(): [number, number];
  now(): number;
  rss(): number;
  cpuUsage(): [number, number];
  totalmem(): number;
  utf8Length(text: string): number;
  /** The string's UTF-16LE code units into the view from `offset`, whole units while they fit: the bytes written. */
  writeUtf16le(text: string, view: Uint8Array, offset: number): number;
  /** Workers by fork (docs/fork_workers_design.md): the entry a forked child runs with its data. */
  setWorkerEntry(entry: (data: unknown) => void): void;
  /** Forks a worker that runs the entry with `data` (the same objects): its id. */
  /** `shared`: the worker allocates into a region the parent reads; a graph it publishes is passed by reference. */
  forkWorker(data: unknown, shared?: boolean): number;
  onWorkerMessage(id: number, listener: (value: unknown) => void): void;
  onWorkerError(id: number, listener: (error: unknown) => void): void;
  isWorker(): boolean;
  workerData(): unknown;
  /** In a worker: a message to the parent (plain data; anything else throws). */
  postMessage(value: unknown): void;
  /** The parent posts to a live worker; the worker listens on its parent port and closes it when done. */
  sendToWorker(id: number, value: unknown): void;
  onParentMessage(listener: (value: unknown) => void): void;
  closeParentPort(): void;
  cpus(): number;
  readonly platform: string;
}
export const host = (globalThis as unknown as { __garnetHost: GarnetHost }).__garnetHost;

/** A Node-style error for a failed host call (`code` the errno name). */
export function hostError(syscall: string, path?: string): Error {
  const code = host.lastError();
  const error = new Error(path === undefined ? `${code}: ${syscall}` : `${code}: ${syscall} '${path}'`);
  (error as Error & { code: string }).code = code;
  return error;
}
