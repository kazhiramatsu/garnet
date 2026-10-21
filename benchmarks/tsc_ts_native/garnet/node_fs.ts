// node:fs for tsc-ts over the native host: the synchronous calls it uses.
import { host, hostError } from './host.js';

export interface Stats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
}
export interface Dirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface FSWatcher {
  close(): void;
}

class HostStats implements Stats {
  constructor(private readonly kind: number, readonly size: number, readonly mtimeMs: number) {}
  isFile(): boolean { return this.kind === 1; }
  isDirectory(): boolean { return this.kind === 2; }
  isSymbolicLink(): boolean { return this.kind === 3; }
}
class HostDirent implements Dirent {
  constructor(readonly name: string, private readonly kind: number) {}
  isFile(): boolean { return this.kind === 1; }
  isDirectory(): boolean { return this.kind === 2; }
  isSymbolicLink(): boolean { return this.kind === 3; }
}

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

export function readFileSync(path: string): Uint8Array;
export function readFileSync(path: string, encoding: 'utf8' | 'utf-8'): string;
export function readFileSync(path: string, encoding?: 'utf8' | 'utf-8'): string | Uint8Array {
  const bytes = host.readFile(path);
  if (bytes === undefined) throw hostError('open', path);
  return encoding === undefined ? bytes : utf8.decode(bytes);
}
export function writeFileSync(path: string, data: string | Uint8Array): void {
  if (!host.writeFile(path, data)) throw hostError('open', path);
}
export function writeSync(fd: number, data: string | Uint8Array, offset?: number, length?: number): number {
  const written = host.writeFd(fd, data, offset, length);
  if (written < 0) throw hostError('write');
  return written;
}
export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, _position: number | null): number {
  const read = host.readFd(fd, buffer, offset, length);
  if (read < 0) throw hostError('read');
  return read;
}
function statOf(path: string, follow: boolean): Stats {
  const stat = host.stat(path, follow);
  if (stat === undefined) throw hostError(follow ? 'stat' : 'lstat', path);
  return new HostStats(stat[0], stat[1], stat[2]);
}
export function statSync(path: string): Stats { return statOf(path, true); }
export function lstatSync(path: string): Stats { return statOf(path, false); }
export function existsSync(path: string): boolean { return host.stat(path, true) !== undefined; }
export function readdirSync(path: string): string[];
export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
export function readdirSync(path: string, options?: { withFileTypes: true }): string[] | Dirent[] {
  const entries = host.readdir(path);
  if (entries === undefined) throw hostError('scandir', path);
  if (options === undefined) return entries[0];
  const dirents: Dirent[] = [];
  for (let i = 0; i < entries[0].length; i++) dirents.push(new HostDirent(entries[0][i]!, entries[1][i]!));
  return dirents;
}
export function mkdirSync(path: string, options?: { recursive?: boolean }): void {
  if (!host.mkdir(path, options?.recursive === true) && !(options?.recursive === true && host.stat(path, true)?.[0] === 2))
    throw hostError('mkdir', path);
}
export function realpathSync(path: string): string {
  const real = host.realpath(path);
  if (real === undefined) throw hostError('realpath', path);
  return real;
}
export function unlinkSync(path: string): void {
  if (!host.unlink(path)) throw hostError('unlink', path);
}
export function utimesSync(path: string, atime: Date | number, mtime: Date | number): void {
  const at = typeof atime === 'number' ? atime * 1000 : atime.getTime();
  const mt = typeof mtime === 'number' ? mtime * 1000 : mtime.getTime();
  if (!host.utimes(path, at, mt)) throw hostError('utime', path);
}
/** Watch mode is not available on this host. */
export function watch(_path: string, _listener?: () => void): FSWatcher {
  throw new Error('fs.watch is not available in the garnet build of tsc-ts');
}
