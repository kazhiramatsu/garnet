// Dynamic properties on class instances, whose property map lives in a
// sidecar behind the instance's prefix (docs/cell_header_design.md, H2):
// data properties, accessors, Symbol keys and non-enumerable ones added to
// young and old instances (sized and header-only, heap and stack), read
// through the property caches, enumerated, deleted, frozen and relinked,
// with collections in between.
class One { a: any; constructor(i: number) { this.a = { v: i }; } }
class Three { a: any; b: any; c: any; constructor(i: number) { this.a = i; this.b = "b" + i; this.c = [i]; } }
class Bare { tag(): string { return "bare"; } }
class Wide {
  f0: any = 0;
  f1: any = 1;
  f2: any = 2;
  f3: any = 3;
  f4: any = 4;
  f5: any = 5;
  f6: any = 6;
  f7: any = 7;
  f8: any = 8;
  f9: any = 9;
  f10: any = 10;
  f11: any = 11;
  f12: any = 12;
  f13: any = 13;
  f14: any = 14;
  f15: any = 15;
  f16: any = 16;
  f17: any = 17;
  f18: any = 18;
  f19: any = 19;
  f20: any = 20;
  f21: any = 21;
  f22: any = 22;
  f23: any = 23;
  f24: any = 24;
  f25: any = 25;
  f26: any = 26;
  f27: any = 27;
  f28: any = 28;
  f29: any = 29;
  f30: any = 30;
  f31: any = 31;
  f32: any = 32;
  f33: any = 33;
  f34: any = 34;
  f35: any = 35;
  f36: any = 36;
  f37: any = 37;
  f38: any = 38;
  f39: any = 39;
  f40: any = 40;
  f41: any = 41;
  f42: any = 42;
  f43: any = 43;
  f44: any = 44;
  f45: any = 45;
  f46: any = 46;
  f47: any = 47;
  f48: any = 48;
  f49: any = 49;
  f50: any = 50;
  f51: any = 51;
  f52: any = 52;
  f53: any = 53;
  f54: any = 54;
  f55: any = 55;
  f56: any = 56;
  f57: any = 57;
  f58: any = 58;
  f59: any = 59;
  f60: any = 60;
  f61: any = 61;
  f62: any = 62;
  f63: any = 63;
  f64: any = 64;
  f65: any = 65;
  f66: any = 66;
  f67: any = 67;
  f68: any = 68;
  f69: any = 69;
  f70: any = 70;
  f71: any = 71;
  f72: any = 72;
  f73: any = 73;
  f74: any = 74;
  f75: any = 75;
  f76: any = 76;
  f77: any = 77;
  f78: any = 78;
  f79: any = 79;
  f80: any = 80;
  f81: any = 81;
  f82: any = 82;
  f83: any = 83;
  f84: any = 84;
  f85: any = 85;
  f86: any = 86;
  f87: any = 87;
  f88: any = 88;
  f89: any = 89;
  f90: any = 90;
  f91: any = 91;
  f92: any = 92;
  f93: any = 93;
  f94: any = 94;
  f95: any = 95;
  f96: any = 96;
  f97: any = 97;
  f98: any = 98;
  f99: any = 99;
  f100: any = 100;
  f101: any = 101;
  f102: any = 102;
  f103: any = 103;
  f104: any = 104;
  f105: any = 105;
  f106: any = 106;
  f107: any = 107;
  f108: any = 108;
  f109: any = 109;
  f110: any = 110;
  f111: any = 111;
  f112: any = 112;
  f113: any = 113;
  f114: any = 114;
  f115: any = 115;
  f116: any = 116;
  f117: any = 117;
  f118: any = 118;
  f119: any = 119;
  f120: any = 120;
  f121: any = 121;
  f122: any = 122;
  f123: any = 123;
  f124: any = 124;
  f125: any = 125;
  f126: any = 126;
  f127: any = 127;
  f128: any = 128;
  f129: any = 129;
  f130: any = 130;
  f131: any = 131;
  f132: any = 132;
  f133: any = 133;
  f134: any = 134;
  f135: any = 135;
  f136: any = 136;
  f137: any = 137;
  f138: any = 138;
  f139: any = 139;
  f140: any = 140;
  f141: any = 141;
  f142: any = 142;
  f143: any = 143;
  f144: any = 144;
  f145: any = 145;
  f146: any = 146;
  f147: any = 147;
  f148: any = 148;
  f149: any = 149;
  f150: any = 150;
  f151: any = 151;
  f152: any = 152;
  f153: any = 153;
  f154: any = 154;
  f155: any = 155;
  f156: any = 156;
  f157: any = 157;
  f158: any = 158;
  f159: any = 159;
  f160: any = 160;
  f161: any = 161;
  f162: any = 162;
  f163: any = 163;
  f164: any = 164;
  f165: any = 165;
  f166: any = 166;
  f167: any = 167;
  f168: any = 168;
  f169: any = 169;
  f170: any = 170;
  f171: any = 171;
  f172: any = 172;
  f173: any = 173;
  f174: any = 174;
  f175: any = 175;
  f176: any = 176;
  f177: any = 177;
  f178: any = 178;
  f179: any = 179;
  f180: any = 180;
  f181: any = 181;
  f182: any = 182;
  f183: any = 183;
  f184: any = 184;
  f185: any = 185;
  f186: any = 186;
  f187: any = 187;
  f188: any = 188;
  f189: any = 189;
  f190: any = 190;
  f191: any = 191;
  f192: any = 192;
  f193: any = 193;
  f194: any = 194;
  f195: any = 195;
  f196: any = 196;
  f197: any = 197;
  f198: any = 198;
  f199: any = 199;
  f200: any = 200;
  f201: any = 201;
  f202: any = 202;
  f203: any = 203;
  f204: any = 204;
  f205: any = 205;
  f206: any = 206;
  f207: any = 207;
  f208: any = 208;
  f209: any = 209;
  f210: any = 210;
  f211: any = 211;
  f212: any = 212;
  f213: any = 213;
  f214: any = 214;
  f215: any = 215;
  f216: any = 216;
  f217: any = 217;
  f218: any = 218;
  f219: any = 219;
  f220: any = 220;
  f221: any = 221;
  f222: any = 222;
  f223: any = 223;
  f224: any = 224;
  f225: any = 225;
  f226: any = 226;
  f227: any = 227;
  f228: any = 228;
  f229: any = 229;
  f230: any = 230;
  f231: any = 231;
  f232: any = 232;
  f233: any = 233;
  f234: any = 234;
  f235: any = 235;
  f236: any = 236;
  f237: any = 237;
  f238: any = 238;
  f239: any = 239;
  f240: any = 240;
  f241: any = 241;
  f242: any = 242;
  f243: any = 243;
  f244: any = 244;
  f245: any = 245;
  f246: any = 246;
  f247: any = 247;
  f248: any = 248;
  f249: any = 249;
  f250: any = 250;
  f251: any = 251;
  f252: any = 252;
  f253: any = 253;
  f254: any = 254;
  f255: any = 255;
  f256: any = 256;
  f257: any = 257;
  f258: any = 258;
  f259: any = 259;
}
function churn(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { const t = { a: i, b: [i, i + 1] }; s = (s + t.a + t.b.length) % 1000; }
  return s;
}
function show(v: any): string {
  if (v === undefined) return "u";
  if (v === null) return "n";
  if (Array.isArray(v)) return "[" + v.map(show).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map((k) => k + ":" + show(v[k])).join(",") + "}";
  return String(v);
}
const sym = Symbol("s");
function decorate(x: any, i: number): void {
  x.extra = { e: i };
  x["k" + (i % 3)] = [i];
  x[sym] = "sym" + i;
  Object.defineProperty(x, "hidden", { value: i * 10, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(x, "twice", { get() { return this.a !== undefined ? i * 2 : -1; }, enumerable: true, configurable: true });
}
function readAll(x: any): string {
  return show(x.extra) + show(x.k0) + show(x.k1) + show(x.k2) + show(x[sym]) + show(x.hidden) + show(x.twice);
}
function stackLocal(i: number): string {
  const t = new Three(i);
  const d: any = t;
  decorate(d, i);
  churn(500);
  const r = readAll(d) + t.a + t.b + t.c[0];
  delete d.extra;
  return r + show(d.extra) + Object.keys(t).join("");
}
function main(): void {
  const ones: One[] = [], threes: Three[] = [], bares: Bare[] = [];
  for (let i = 0; i < 40; i++) { ones.push(new One(i)); threes.push(new Three(i)); bares.push(new Bare()); }
  // young instances take properties, then age
  for (let i = 0; i < 40; i += 4) { decorate(ones[i], i); decorate(threes[i], i); decorate(bares[i], i); }
  let s = churn(300000);
  // old instances take more properties, young values
  for (let i = 2; i < 40; i += 4) { decorate(ones[i], i); decorate(threes[i], i); decorate(bares[i], i); }
  s += churn(200000);
  const lines: string[] = [];
  for (let i = 0; i < 12; i += 2) lines.push(readAll(ones[i]) + "|" + readAll(threes[i]) + "|" + readAll(bares[i]) + "|" + ones[i].a.v + threes[i].b);
  console.log("props", lines.join(" "));
  // a property cache over instances with and without the properties
  let hits = 0;
  for (let r = 0; r < 3; r++) for (let i = 0; i < 40; i++) { const x: any = threes[i]; if (x.extra !== undefined) hits += x.extra.e; if (x.k1 !== undefined) hits += x.k1[0]; }
  console.log("cache", hits);
  // enumeration
  const t4: any = threes[4];
  console.log("keys", Object.keys(t4).join(","), Object.entries(ones[8]).map((e) => e[0]).join(","));
  let forin = ""; for (const k in t4) forin += k + ";";
  console.log("forin", forin);
  console.log("spread", show({ ...t4 }), show(Object.assign({}, bares[8])));
  console.log("json", JSON.stringify(t4), JSON.stringify(ones[0]), JSON.stringify(bares[4]));
  console.log("own", Object.getOwnPropertyNames(t4).join(","), Object.getOwnPropertySymbols(t4).length, String(Object.getOwnPropertyDescriptor(t4, "hidden")!.enumerable));
  // deletes: a dynamic property, a struct field (the conversion), on old instances
  for (let i = 0; i < 40; i += 4) { delete (threes[i] as any).k0; delete (ones[i] as any).extra; }
  for (let i = 0; i < 40; i += 8) { delete (threes[i] as any).b; delete (ones[i] as any).a; }
  s += churn(200000);
  const del: string[] = [];
  for (let i = 0; i < 40; i += 8) del.push(readAll(threes[i]) + show((threes[i] as any).a) + show((threes[i] as any).b) + Object.keys(threes[i]).join("") + "/" + readAll(ones[i]) + show((ones[i] as any).a));
  console.log("deleted", del.join(" "));
  // frozen and sealed instances refuse additions
  const fz: any = threes[12]; Object.freeze(fz);
  const sl: any = ones[14]; Object.seal(sl);
  let refused = "";
  try { fz.added = 1; refused += "fz-added"; } catch (e) { refused += e instanceof TypeError ? "fz-TypeError" : "fz-other"; }
  try { sl.added = 1; refused += ",sl-added"; } catch (e) { refused += e instanceof TypeError ? ",sl-TypeError" : ",sl-other"; }
  try { fz.extra = 5; refused += ",fz-write"; } catch (e) { refused += e instanceof TypeError ? ",fz-write-TypeError" : ",fz-write-other"; }
  sl.extra = { resealed: 1 };
  console.log("frozen", refused, readAll(fz), show(sl.extra), Object.isFrozen(fz), Object.isSealed(sl));
  // relinked instances keep their own properties
  const rl: any = threes[16]; Object.setPrototypeOf(rl, One.prototype);
  rl.after = "relinked";
  s += churn(100000);
  console.log("relinked", readAll(rl), show(rl.after), show(rl.a), rl instanceof One, rl instanceof Three);
  // a wide instance (extent past one byte) with dynamic properties and a struct-field delete
  const ws: Wide[] = [];
  for (let i = 0; i < 4; i++) ws.push(new Wide());
  s += churn(200000);
  for (let i = 0; i < 4; i++) { const w: any = ws[i]; w.dyn = { w: i }; w[sym] = i; w.f259 = "last" + i; }
  delete (ws[1] as any).f3;
  s += churn(200000);
  let wide = "";
  for (let i = 0; i < 4; i++) { const w: any = ws[i]; wide += show(w.dyn) + show(w[sym]) + show(w.f259) + show(w.f3) + show(w.f0) + Object.keys(w).length + ";"; }
  console.log("wide", wide);
  // stack instances take properties too
  let st = "";
  for (let i = 0; i < 6; i++) st += stackLocal(i) + " ";
  console.log("stack", st);
  console.log("done", s >= 0);
}
main();
