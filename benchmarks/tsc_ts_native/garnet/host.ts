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
