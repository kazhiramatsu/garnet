// `process` and `Buffer` for tsc-ts over the native host (the entry imports
// this first, so every module sees them).
import { host } from './host.js';

const encoder = new TextEncoder();
function writer(fd: number): GarnetWritable {
  return {
    write(text: string | Uint8Array): boolean {
      const bytes = typeof text === 'string' ? encoder.encode(text) : text;
      let offset = 0;
      while (offset < bytes.length) {
        const written = host.writeFd(fd, bytes, offset, bytes.length - offset);
        if (written < 0) throw new Error(`write to ${fd} failed: ${host.lastError()}`);
        offset += written;
      }
      return true;
    },
    isTTY: host.isatty(fd),
  };
}
const argv = host.argv();
const execPath = host.execPath();
const garnetProcess: GarnetProcess = {
  env: host.env(),
  // as Node: the executable, the script, then the arguments
  argv: [execPath, argv[0] ?? 'tsc-ts', ...argv.slice(1)],
  execPath,
  platform: host.platform,
  pid: host.pid(),
  get ppid(): number { return host.ppid(); },
  exitCode: undefined,
  stdout: writer(1),
  stderr: writer(2),
  exit(code?: number): never { return host.exit(code ?? garnetProcess.exitCode ?? 0); },
  cwd: () => host.cwd(),
  hrtime(previous?: [number, number]): [number, number] {
    const now = host.hrtime();
    if (previous === undefined) return now;
    let seconds = now[0] - previous[0];
    let nanoseconds = now[1] - previous[1];
    if (nanoseconds < 0) { seconds--; nanoseconds += 1e9; }
    return [seconds, nanoseconds];
  },
  threadCpuUsage(): { user: number; system: number } {
    const usage = host.cpuUsage();
    return { user: usage[0], system: usage[1] };
  },
  constrainedMemory: () => 0,
  memoryUsage: { rss: () => host.rss() },
  kill(): true { throw new Error('process.kill is not available in the garnet build'); },
};
/** Buffer.prototype.write for the views `Buffer.from` makes. */
function bufferWrite(this: Uint8Array, text: string, encoding?: 'utf8' | 'utf-8' | 'utf16le'): number {
  if (encoding === 'utf16le') return host.writeUtf16le(text, this, 0);
  return encoder.encodeInto(text, this).written;
}
function asBuffer(view: Uint8Array): GarnetBuffer {
  (view as unknown as { write: typeof bufferWrite }).write = bufferWrite;
  return view as GarnetBuffer;
}
function bufferFrom(source: string | ArrayBufferLike, offset?: number | string, length?: number): GarnetBuffer {
  if (typeof source === 'string') return asBuffer(encoder.encode(source));
  return asBuffer(new Uint8Array(source, typeof offset === 'number' ? offset : 0, length));
}
const garnetBuffer: GarnetBufferConstructor = {
  from: bufferFrom as GarnetBufferConstructor['from'],
  byteLength: (text: string) => host.utf8Length(text),
  compare(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  },
};
const global = globalThis as unknown as {
  process: GarnetProcess;
  Buffer: GarnetBufferConstructor;
  performance: { now(): number };
};
global.process = garnetProcess;
global.Buffer = garnetBuffer;
// the global clock some modules read without importing node:perf_hooks
global.performance = { now: () => host.now() };
