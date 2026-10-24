// TextDecoder on large inputs with some non-ASCII: a source file of 3 MB with one
// Bengali character in a comment made the decoder leave its all-ASCII path and go
// through a UTF-16 buffer; large inputs are now decoded straight into their storage,
// one byte per unit when every code point fits, UTF-16 otherwise. Large mixed,
// Latin-1, BMP, astral, invalid, truncated and BOM inputs against V8.
function main(): void {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const fatal = new TextDecoder("utf-8", { fatal: true });
  function big(seed: string, n: number, tail: string): Uint8Array {
    let s = ""; for (let i = 0; i < n; i++) s += seed + String(i) + "\n"; s += tail;
    return enc.encode(s);
  }
  function digest(s: string): string {
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return s.length + ":" + h + ":" + s.charCodeAt(0) + ":" + s.charCodeAt(s.length - 1);
  }
  const cases: [string, Uint8Array][] = [
    ["ascii", big("let x = 1; // plain ", 20000, "end")],
    ["latin1", big("const café = 1; // naïve ", 20000, "ÿ")],
    ["bmp", big("let x = 1; // plain ", 20000, "৹ end")],
    ["astral", big("let x = 1; // plain ", 20000, "😀 end")],
    ["mixed", big("aéb€c😀 ", 10000, "")],
    ["small-latin1", enc.encode("café")],
    ["small-bmp", enc.encode("x৹y")],
  ];
  for (const [name, bytes] of cases) {
    const s = dec.decode(bytes); const t = fatal.decode(bytes);
    console.log(name, bytes.length, digest(s), s === t);
  }
  // invalid sequences at the end of a large input: replacement characters; fatal throws
  const bad = big("ok ", 20000, ""); const arr = new Uint8Array(bad.length + 6); arr.set(bad);
  arr[bad.length] = 0xc3; arr[bad.length + 1] = 0x28; arr[bad.length + 2] = 0xe2; arr[bad.length + 3] = 0x82; arr[bad.length + 4] = 0xf0; arr[bad.length + 5] = 0x41;
  const r = dec.decode(arr); console.log("invalid", r.length, digest(r), r.slice(-8).split("").map(c => c.charCodeAt(0)).join(","));
  let threw = false; try { fatal.decode(arr); } catch (e) { threw = e instanceof TypeError; } console.log("fatal throws", threw);
  // a truncated multibyte sequence at the end of a large input
  const trunc = new Uint8Array(bad.length + 2); trunc.set(bad); trunc[bad.length] = 0xe0; trunc[bad.length + 1] = 0xa4;
  const u = dec.decode(trunc); console.log("truncated", u.length, u.charCodeAt(u.length - 1));
  // a BOM on a large input, kept with ignoreBOM
  const bom = new Uint8Array(bad.length + 3); bom[0] = 0xef; bom[1] = 0xbb; bom[2] = 0xbf; bom.set(bad, 3);
  console.log("bom", dec.decode(bom).length, new TextDecoder("utf-8", { ignoreBOM: true }).decode(bom).charCodeAt(0));
}
main();
