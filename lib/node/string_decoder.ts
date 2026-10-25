// node:string_decoder: decoding across chunk boundaries, keeping an incomplete
// character (utf8), an odd byte (utf16le) or a partial group (base64) for the next write.
import { Buffer, normalizeEncoding } from "./buffer";
import { codedTypeError } from "./errors";

export class StringDecoder {
  readonly encoding: string;
  private readonly enc: "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex";
  private pending: Uint8Array = new Uint8Array(0);
  constructor(encoding?: string) {
    const e = normalizeEncoding(encoding === undefined ? "utf8" : encoding);
    if (e === undefined) throw codedTypeError("ERR_UNKNOWN_ENCODING", "Unknown encoding: " + encoding);
    this.enc = e;
    this.encoding = e;
  }
  /** The bytes a complete decode may not include yet: the trailing partial character's. */
  private incomplete(bytes: Uint8Array): number {
    const n = bytes.length;
    if (this.enc === "utf8") {
      // walk back over up to three continuation bytes to the lead byte
      let i = n - 1, cont = 0;
      while (i >= 0 && cont < 3 && (bytes[i] & 0xC0) === 0x80) { i--; cont++; }
      if (i < 0) return 0;
      const lead = bytes[i];
      const need = (lead & 0xE0) === 0xC0 ? 1 : (lead & 0xF0) === 0xE0 ? 2 : (lead & 0xF8) === 0xF0 ? 3 : 0;
      return need > cont ? cont + 1 : 0;
    }
    if (this.enc === "utf16le") return n & 1;
    if (this.enc === "base64" || this.enc === "base64url") return n % 3;
    return 0;
  }
  write(buffer: Uint8Array | string): string {
    const chunk = typeof buffer === "string" ? Buffer.from(buffer, "utf8") : buffer;
    let bytes: Uint8Array;
    if (this.pending.length === 0) bytes = chunk;
    else { bytes = new Uint8Array(this.pending.length + chunk.length); bytes.set(this.pending); bytes.set(chunk, this.pending.length); }
    const keep = this.incomplete(bytes);
    const done = bytes.subarray(0, bytes.length - keep);
    this.pending = keep === 0 ? new Uint8Array(0) : new Uint8Array(bytes.subarray(bytes.length - keep));
    return Buffer.from(done).toString(this.enc);
  }
  end(buffer?: Uint8Array | string): string {
    let out = buffer === undefined ? "" : this.write(buffer);
    if (this.pending.length > 0) {
      const rest = this.pending;
      this.pending = new Uint8Array(0);
      out += this.enc === "utf8" ? "�" : this.enc === "utf16le" ? "" : Buffer.from(rest).toString(this.enc);
    }
    return out;
  }
  text(buffer: Uint8Array, offset: number): string { return this.write(buffer.subarray(offset)); }
}
const string_decoder = { StringDecoder };
export default string_decoder;
