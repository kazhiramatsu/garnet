// TextDecoder on all-ASCII input (a source text), on short input, with a BOM,
// on non-ASCII and invalid bytes, and from a typed-array view with an offset.
function main() {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const out: unknown[] = [];
  let src = "";
  for (let i = 0; i < 30; i++) src += "const v" + i + " = " + i + "; // ok\n";
  const bytes = enc.encode(src);
  const text = dec.decode(bytes);
  out.push(text.length, text === src, text.charCodeAt(0), text.indexOf("v29"), text.slice(-6));
  out.push(dec.decode(enc.encode("")), dec.decode(enc.encode("a")), dec.decode(enc.encode("abcde")), dec.decode(enc.encode("abcdef")), dec.decode(enc.encode("abcdefgh")));
  out.push(dec.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62])), new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])).length);
  out.push(dec.decode(enc.encode("héllo wörld ✓ 日本")), dec.decode(new Uint8Array([0x61, 0xff, 0x62])), dec.decode(new Uint8Array([0xe2, 0x82])).length);
  const buf = new Uint8Array(16);
  for (let i = 0; i < 16; i++) buf[i] = 0x41 + i;
  out.push(dec.decode(buf.subarray(4, 12)), dec.decode(buf.buffer), dec.decode(new Uint8Array(buf.buffer, 2, 5)));
  out.push(dec.decode(undefined), dec.decode(new Uint8Array(0)));
  console.log(JSON.stringify(out));
}
main();
