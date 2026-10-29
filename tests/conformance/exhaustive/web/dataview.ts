// DataView (docs/web_fetch_api_design.md): the constructor's offset and length and their
// RangeErrors, the integer accessors in both byte orders, the float accessors, the negative
// values, writes read back through a Uint8Array over the same buffer, an access past the end.
function names(e: unknown): string { return (e as Error).constructor.name; }
function main() {
  const out: unknown[] = [];
  const buf = new ArrayBuffer(16);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 16; i++) u8[i] = i * 17;
  const dv = new DataView(buf);
  out.push(dv.byteLength, dv.byteOffset, dv.buffer === buf, dv.getUint8(1), dv.getInt8(15), dv.getUint16(1), dv.getUint16(1, true), dv.getInt16(14), dv.getUint32(2), dv.getUint32(2, true), dv.getInt32(12), dv.getInt32(12, true));
  const part = new DataView(buf, 4, 8); out.push(part.byteLength, part.byteOffset, part.getUint8(0), new DataView(buf, 16).byteLength);
  for (const [o, l] of [[17, undefined], [4, 13], [-1, undefined]] as [number, number | undefined][]) { try { new DataView(buf, o, l); out.push("ok"); } catch (e) { out.push(names(e)); } }
  try { new DataView({} as any); out.push("ok"); } catch (e) { out.push(names(e)); }
  dv.setUint16(0, 0x1234); dv.setUint16(2, 0x1234, true); dv.setInt16(4, -2); dv.setUint32(6, 0xdeadbeef); dv.setInt32(10, -3, true);
  out.push([...u8.slice(0, 14)]);
  dv.setFloat32(0, 1.5); dv.setFloat64(4, -2.25, true); dv.setFloat32(12, 3.14159, true);
  out.push(dv.getFloat32(0), dv.getFloat64(4, true), [...u8.slice(0, 4)], [...u8.slice(4, 12)], Math.round(dv.getFloat32(12, true) * 1e5) / 1e5);
  dv.setFloat64(0, Number.NaN); out.push(Number.isNaN(dv.getFloat64(0)), dv.getFloat64(0, true) === dv.getFloat64(0, true));
  for (const call of [() => dv.getUint8(16), () => dv.getUint32(13), () => dv.getFloat64(9), () => dv.setUint16(15, 1)]) { try { call(); out.push("ok"); } catch (e) { out.push(names(e)); } }
  out.push(dv.getUint8(-0), Object.prototype.toString.call(dv), dv instanceof DataView);
  console.log(JSON.stringify(out));
}
main();
