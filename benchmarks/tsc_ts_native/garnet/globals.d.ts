// The Node globals tsc-ts reads, which @types/node declares in its Node build
// (prelude.ts creates them over the host).
interface GarnetWritable {
  write(text: string | Uint8Array): boolean;
  readonly isTTY?: boolean;
}
interface GarnetProcess {
  env: { [name: string]: string | undefined };
  argv: string[];
  execPath: string;
  platform: string;
  pid: number;
  readonly ppid: number;
  exitCode: number | undefined;
  stdout: GarnetWritable;
  stderr: GarnetWritable;
  exit(code?: number): never;
  cwd(): string;
  hrtime(previous?: [number, number]): [number, number];
  threadCpuUsage(): { user: number; system: number };
  constrainedMemory(): number;
  memoryUsage: { rss(): number };
  kill(pid: number, signal?: string | number): true;
}
declare var process: GarnetProcess;
/** A Uint8Array with Node's `write`. */
interface GarnetBuffer extends Uint8Array {
  write(text: string, encoding?: 'utf8' | 'utf-8' | 'utf16le'): number;
}
interface GarnetBufferConstructor {
  /** The UTF-8 bytes of a string. */
  from(text: string, encoding?: 'utf8' | 'utf-8'): GarnetBuffer;
  /** A view of an ArrayBuffer's bytes. */
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): GarnetBuffer;
  byteLength(text: string, encoding?: string): number;
  compare(a: Uint8Array, b: Uint8Array): number;
}
declare var Buffer: GarnetBufferConstructor;
