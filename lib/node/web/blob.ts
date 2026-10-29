// Blob and File (docs/web_streams_design.md "Blob and File"): the byte containers a body, a FormData
// file part and `blob()` hand out. A Blob holds its parts as Node's does (each part's bytes copied
// when it is made, a nested Blob's parts taken one by one, an empty part dropped): `stream()` and a
// body of the Blob hand them out one chunk per part, `slice` keeps the boundaries. Under the V8
// oracle the globals are Node's own, whose behaviour these follow.
import { ReadableStream } from "./streams";

export type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;
function isView(v: unknown): v is ArrayBufferView {
  return typeof v === "object" && v !== null && typeof (v as ArrayBufferView).byteLength === "number" && typeof (v as ArrayBufferView).byteOffset === "number" && (v as ArrayBufferView).buffer instanceof ArrayBuffer;
}
/** one part's bytes appended, copied (a Blob part contributes its own parts, which never change) */
function pushPart(parts: Uint8Array[], part: unknown): void {
  if (part instanceof Blob) { for (const p of Blob.__parts(part)) parts.push(p); return; }
  let b: Uint8Array;
  if (part instanceof ArrayBuffer) b = new Uint8Array(part.slice(0));
  else if (isView(part)) { b = new Uint8Array(part.byteLength); b.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength)); }
  else b = new TextEncoder().encode(String(part));
  if (b.length > 0) parts.push(b);
}
/** A blob's type: lowercased; a type with a character outside printable ASCII is the empty string. */
function normalizeType(type: unknown): string {
  const t = String(type);
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c < 0x20 || c > 0x7e) return ""; }
  return t.toLowerCase();
}
/** every part as one array (a single part is returned as it is: the callers never write it) */
export function concatParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export class Blob {
  #parts: Uint8Array[];
  #size: number;
  #type: string;
  constructor(blobParts?: Iterable<BlobPart>, options?: { type?: string; endings?: string }) {
    const parts: Uint8Array[] = [];
    if (blobParts !== undefined) {
      if (blobParts === null || typeof blobParts !== "object" || typeof (blobParts as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
        throw new TypeError("The \"blobParts\" argument must be an iterable of Blob, Buffer, TypedArray, DataView, ArrayBuffer or string");
      }
      if (options !== undefined && options !== null && options.endings !== undefined && options.endings !== "transparent" && options.endings !== "native") {
        throw new TypeError(`The provided value '${String(options.endings)}' is not a valid enum value of type EndingType.`);
      }
      for (const part of blobParts) pushPart(parts, part);
    }
    this.#parts = parts;
    let size = 0;
    for (const p of parts) size += p.length;
    this.#size = size;
    this.#type = options !== undefined && options !== null && options.type !== undefined ? normalizeType(options.type) : "";
  }
  get size(): number { return this.#size; }
  get type(): string { return this.#type; }
  async text(): Promise<string> { return new TextDecoder().decode(concatParts(this.#parts)); }
  async arrayBuffer(): Promise<ArrayBuffer> { const out = new ArrayBuffer(this.#size); new Uint8Array(out).set(concatParts(this.#parts)); return out; }
  async bytes(): Promise<Uint8Array> { const out = new Uint8Array(this.#size); out.set(concatParts(this.#parts)); return out; }
  /** the bytes between `start` and `end` (negative from the end), the part boundaries kept */
  slice(start?: number, end?: number, contentType?: string): Blob {
    const n = this.#size;
    let a = start === undefined ? 0 : Math.trunc(Number(start)) || 0;
    let b = end === undefined ? n : Math.trunc(Number(end)) || 0;
    a = a < 0 ? Math.max(n + a, 0) : Math.min(a, n);
    b = b < 0 ? Math.max(n + b, 0) : Math.min(b, n);
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const p of this.#parts) {
      const from = Math.max(a - at, 0), to = Math.min(b - at, p.length);
      if (to > from) parts.push(p.slice(from, to));
      at += p.length;
    }
    return Blob.__fromParts(parts, contentType === undefined ? "" : normalizeType(contentType));
  }
  stream(): ReadableStream<Uint8Array> {
    const parts = this.#parts;
    return new ReadableStream<Uint8Array>({ start(controller) { for (const p of parts) controller.enqueue(p.slice()); controller.close(); } });
  }
  get [Symbol.toStringTag](): string { return "Blob"; }
  /** the parts of a blob and all its bytes (not copied: for this module and the bodies, which never write them) */
  static __parts(b: Blob): Uint8Array[] { return b.#parts; }
  static __bytes(b: Blob): Uint8Array { return concatParts(b.#parts); }
  static __fromParts(parts: Uint8Array[], type: string): Blob {
    const b = new Blob();
    b.#parts = parts;
    let size = 0;
    for (const p of parts) size += p.length;
    b.#size = size;
    b.#type = type;
    return b;
  }
  static __fromBytes(bytes: Uint8Array, type: string): Blob { return Blob.__fromParts(bytes.length === 0 ? [] : [bytes], type); }
}

export class File extends Blob {
  #name: string;
  #lastModified: number;
  constructor(fileBits: Iterable<BlobPart>, fileName: string, options?: { type?: string; endings?: string; lastModified?: number }) {
    if (fileBits === undefined || fileName === undefined) throw new TypeError("The \"fileBits\" and \"fileName\" arguments are required");
    super(fileBits, options);
    this.#name = String(fileName);
    const lm = options !== undefined && options !== null && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    this.#lastModified = Number.isNaN(lm) ? 0 : Math.trunc(lm);
  }
  get name(): string { return this.#name; }
  get lastModified(): number { return this.#lastModified; }
  get webkitRelativePath(): string { return ""; }
  get [Symbol.toStringTag](): string { return "File"; }
  /** a file over given bytes (a multipart part): the bytes copied once more, as any part's are */
  static __of(bytes: Uint8Array, type: string, name: string): File { return new File([bytes], name, { type }); }
}
