// TextEncoder and TextDecoder (docs/text_codecs_design.md): UTF-8 encoding
// (lone surrogates), encodeInto, the standard's UTF-8 and UTF-16 decoders
// with their replacements, the byte order mark, fatal, labels, inputs,
// accessors, brand checks and the constructors as values.
function report(label: string, f: () => unknown): void {
  try { console.log(label, f()); }
  catch (e) { console.log(label, "threw", (e as Error).constructor.name, (e as Error).message); }
}
const hex = (u: Uint8Array): string => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join(" ");
const esc = (s: string): string => Array.from(s).map((c) => {
  const p = c.codePointAt(0)!;
  return p < 0x20 || p > 0x7e ? "\\u{" + p.toString(16) + "}" : c;
}).join("");
const e = new TextEncoder(), d = new TextDecoder();
report("encode", () => hex(e.encode("aé€\u{1F600}\ud800x")));
report("encode empty", () => [e.encode().length, e.encode("").length].join());
report("encode number", () => hex(e.encode(12 as unknown as string)));
report("encodeInto", () => { const u = new Uint8Array(5); const r = e.encodeInto("aé€\u{1F600}", u); return JSON.stringify(r) + " " + hex(u); });
report("encodeInto fits", () => { const u = new Uint8Array(8); return JSON.stringify(e.encodeInto("\u{1F600}ab", u)) + " " + hex(u); });
report("encodeInto bad", () => e.encodeInto("a", new Uint16Array(2) as unknown as Uint8Array));
report("decode", () => esc(d.decode(new Uint8Array([0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]))));
report("decode invalid", () => esc(d.decode(new Uint8Array([0x61, 0x80, 0xc3, 0x28, 0xe2, 0x82, 0xf0, 0x9f, 0x98, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0xff, 0x62, 0xe2]))));
report("decode overlong", () => esc(d.decode(new Uint8Array([0xc0, 0xaf, 0xe0, 0x80, 0xaf, 0xc1, 0xbf]))));
report("decode bom", () => esc(d.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))));
report("decode bom kept", () => esc(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))));
report("fatal", () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0x80])));
report("fatal ok", () => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0x41])));
report("fatal utf16", () => new TextDecoder("utf-16le", { fatal: true }).decode(new Uint8Array([0x41])));
report("utf16le", () => esc(new TextDecoder("utf-16le").decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x3d, 0xd8, 0x00, 0xde, 0x00, 0xd8, 0x42, 0x00, 0x43]))));
report("utf16be", () => esc(new TextDecoder("utf-16be").decode(new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0xd8, 0x3d, 0xde, 0x00]))));
report("utf16 lone low", () => esc(new TextDecoder("utf-16le").decode(new Uint8Array([0x00, 0xdc, 0x41, 0x00]))));
report("labels", () => [" UTF8 ", "unicode-1-1-utf-8", "utf-16", "UCS-2", "unicodefffe", "\tutf-16LE\n"].map((l) => new TextDecoder(l).encoding).join());
report("bad label", () => new TextDecoder("foo"));
report("props", () => { const x = new TextDecoder("utf-8", { fatal: 1 as unknown as boolean, ignoreBOM: false }); return [x.encoding, x.fatal, x.ignoreBOM, e.encoding].join(); });
report("arraybuffer", () => d.decode(new Uint8Array([104, 105]).buffer));
report("shared", () => { const s = new SharedArrayBuffer(2); new Uint8Array(s).set([111, 107]); return d.decode(s); });
report("view", () => d.decode(new Uint16Array([0x6968]).subarray(0, 1)));
report("bad input", () => d.decode("abc" as unknown as Uint8Array));
report("undefined input", () => JSON.stringify(d.decode()));
report("bad this", () => TextEncoder.prototype.encode.call({}, "a"));
report("bad this decoder", () => TextDecoder.prototype.decode.call({}, new Uint8Array(1)));
report("tags", () => [Object.prototype.toString.call(e), Object.prototype.toString.call(d), typeof TextDecoder, e instanceof TextEncoder, d instanceof TextDecoder].join());
report("keys", () => JSON.stringify([Object.keys(e), Object.keys(d), Object.getOwnPropertyNames(d)]));
report("bad options", () => new TextDecoder("utf-8", 5 as unknown as TextDecoderOptions));
report("round trip", () => {
  const s = "x".repeat(1000) + "é\u{1F600}" + "y".repeat(300);
  const b = e.encode(s);
  return [b.length, d.decode(b) === s].join();
});
report("latin1 range", () => { const s = "café ÿ"; return [esc(d.decode(e.encode(s))), d.decode(e.encode(s)) === s].join(); });
