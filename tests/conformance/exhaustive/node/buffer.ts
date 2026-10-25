// node:buffer: the factories, encodings, searches, copies, the integer and float accessors, Node's errors.
import { Buffer, isUtf8, isAscii } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
function fails(f: () => unknown): string { try { f(); return "ok"; } catch (e) { return (e as Error).constructor.name + ":" + (e as { code?: string }).code; } }
function hex(b: Uint8Array): string { return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(""); }
function main(): void {
  const out: string[] = [];
  const b = Buffer.from("héllo wörld", "utf8");
  out.push([b.length, hex(b), b.toString(), b.toString("hex"), b.toString("base64"), b.toString("latin1").length, b.toString("utf8", 1, 3), Buffer.from("aGk=", "base64").toString(), Buffer.from("6869", "hex").toString(), Buffer.from("hi", "utf16le").toString("hex"), Buffer.from("ff00zz", "hex").length].join("|"));
  out.push([b instanceof Buffer, b instanceof Uint8Array, Buffer.isBuffer(b), Buffer.isBuffer(new Uint8Array(1)), Buffer.isBuffer("x"), Buffer.isEncoding("UTF-8"), Buffer.isEncoding("nope"), Buffer.byteLength("héllo"), Buffer.byteLength("aGk=", "base64"), Buffer.byteLength(b), typeof Buffer.poolSize].join("|"));
  const a = Buffer.alloc(5, "ab");
  const z = Buffer.alloc(3);
  out.push([a.toString(), hex(z), Buffer.alloc(4, 7)[3], Buffer.allocUnsafe(2).length, Buffer.from([1, 2, 300]).join(","), Buffer.from(new Uint8Array([5, 6])).toString("hex"), Buffer.from({ type: "Buffer", data: [65, 66] }).toString(), JSON.stringify(Buffer.from("AB").toJSON())].join("|"));
  const sub = b.subarray(1, 3);
  sub[0] = 65;
  out.push([sub.length, sub instanceof Buffer, b.toString("latin1", 1, 2), b.slice(-2).toString("hex"), b.slice(100).length, b.subarray(3, 1).length].join("|"));
  const ab = new ArrayBuffer(8);
  const shared = Buffer.from(ab, 2, 4);
  shared.writeUInt16BE(0x1234, 0);
  out.push([shared.length, new Uint8Array(ab)[2].toString(16), new Uint8Array(ab)[3].toString(16), fails(() => Buffer.from(ab, 9))].join("|"));
  const x = Buffer.from("abcabc");
  out.push([x.indexOf("c"), x.indexOf("c", 3), x.indexOf(98), x.indexOf(Buffer.from("ca")), x.lastIndexOf("a"), x.includes("bc"), x.includes("x"), x.indexOf(""), x.indexOf("c", -2), x.lastIndexOf("c", 2)].join("|"));
  const c = Buffer.alloc(6);
  const n = x.copy(c, 1, 2, 5);
  out.push([n, hex(c), Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString(), Buffer.concat([Buffer.from("abc"), Buffer.from("def")], 4).toString(), Buffer.concat([]).length, Buffer.compare(Buffer.from("a"), Buffer.from("b")), Buffer.compare(Buffer.from("b"), Buffer.from("a")), Buffer.from("ab").compare(Buffer.from("ab")), Buffer.from("ab").equals(Buffer.from("ab")), Buffer.from("ab").equals(new Uint8Array([97, 99]))].join("|"));
  const w = Buffer.alloc(8);
  out.push([w.write("hé", 1), hex(w), w.write("xyz", 6), hex(w), hex(w.fill("ab", 2, 6)), hex(Buffer.alloc(3).fill(255)), hex(Buffer.alloc(4).fill("")), Buffer.alloc(4).fill(Buffer.from([1, 2])).join(",")].join("|"));
  const i = Buffer.alloc(16);
  i.writeUInt8(255, 0); i.writeInt8(-2, 1); i.writeUInt16LE(0xBEEF, 2); i.writeInt16BE(-300, 4); i.writeUInt32LE(0xDEADBEEF, 6); i.writeInt32BE(-123456, 10); i.writeUIntLE(0x1234, 14, 2);
  out.push([hex(i), i.readUInt8(0), i.readInt8(1), i.readUInt16LE(2).toString(16), i.readInt16BE(4), i.readUInt32LE(6).toString(16), i.readInt32BE(10), i.readUIntBE(14, 2).toString(16), i.readIntLE(0, 2), i.readUintLE(2, 3).toString(16)].join("|"));
  const f = Buffer.alloc(16);
  out.push([f.writeDoubleLE(1.5, 0), f.writeFloatBE(-2.25, 8), f.readDoubleLE(0), f.readFloatBE(8), hex(f.subarray(0, 8)), hex(f.subarray(8, 12)), Buffer.from([0, 0, 0xC0, 0x3F]).readFloatLE(0), Buffer.from([0x3F, 0xF0, 0, 0, 0, 0, 0, 0]).readDoubleBE(0)].join("|"));
  out.push([fails(() => i.readUInt32LE(13)), fails(() => i.readUInt8(-1)), fails(() => i.readUInt8(1.5)), fails(() => i.writeUInt8(256, 0)), fails(() => i.writeInt16LE(40000, 0)), fails(() => Buffer.alloc(-1)), fails(() => Buffer.from("x", "nope")), fails(() => Buffer.from(5 as unknown as string)), fails(() => i.readUIntLE(0, 7)), fails(() => Buffer.from("abc").swap16())].join("|"));
  let m = "";
  try { i.writeUInt8(300, 0); } catch (e) { m = (e as Error).message; }
  let m2 = "";
  try { Buffer.alloc(2).readUInt32LE(0); } catch (e) { m2 = (e as Error).message; }
  out.push([m, m2].join("|"));
  out.push([hex(Buffer.from([1, 2, 3, 4]).swap16()), hex(Buffer.from([1, 2, 3, 4]).swap32()), hex(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64()), Buffer.from("héllo").toString("ascii"), Buffer.from("héllo", "latin1").toString("latin1"), Buffer.from("héllo", "latin1").length, Buffer.from("hi").toString("base64url"), Buffer.from("aGk", "base64url").toString(), Buffer.from("a Gk=\n", "base64").toString()].join("|"));
  out.push([isUtf8(Buffer.from("héllo")), isUtf8(Buffer.from([0xC3])), isUtf8(Buffer.from([0xED, 0xA0, 0x80])), isAscii(Buffer.from("abc")), isAscii(Buffer.from("é")), String(Buffer.from("str")), `${Buffer.from("tpl")}`, Buffer.from("A").toLocaleString()].join("|"));
  const d = new StringDecoder("utf8");
  const euro = Buffer.from("€x");
  out.push([d.write(euro.subarray(0, 1)), d.write(euro.subarray(1, 2)), d.write(euro.subarray(2)), d.end(), new StringDecoder("utf8").end(Buffer.from([0xE2, 0x82])), new StringDecoder("utf16le").write(Buffer.from([0x68, 0x00, 0x69])), new StringDecoder("base64").write(Buffer.from("ab")) + new StringDecoder("base64").end(), new StringDecoder("hex").write(Buffer.from([255])), fails(() => new StringDecoder("nope"))].join("|"));
  const g = globalThis as unknown as { Buffer: typeof Buffer; atob(s: string): string; btoa(s: string): string };
  out.push([g.Buffer === Buffer, g.btoa("hi"), g.atob("aGk="), typeof Buffer.from("x").reverse].join("|"));
  console.log(out.join("\n"));
}
main();
