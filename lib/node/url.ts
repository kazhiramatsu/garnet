// node:url (docs/node_compat_design.md): the WHATWG URL and URLSearchParams
// classes (the URL Standard's parser for ASCII hosts: special schemes,
// relative references, the percent-encode sets, dot segments, IPv4 and IPv6
// hosts, default ports, live searchParams), file URL conversions, and the
// legacy url.parse/format/resolve. A host with non-ASCII characters is not
// converted to punycode: such a URL is invalid here.
import { parse as parseQueryString, stringify as stringifyQuery } from "./querystring";
import type { ParsedUrlQuery } from "./querystring";
import { resolve as resolvePath } from "./path";
import { host as nodeHost } from "./host";
import { codedTypeError, invalidArgType } from "./errors";

interface UrlRecord {
  scheme: string;
  username: string;
  password: string;
  host: string | null;
  port: number | null;
  path: string[];
  opaque: string | null;   // an opaque path ("mailto:x"): the path is this string
  query: string | null;
  fragment: string | null;
}

// ---- percent-encoding ----
const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i < 16 ? "0" : "") + i.toString(16).toUpperCase());
type EncodeSet = (c: number) => boolean;
const C0_CONTROL: EncodeSet = (c) => c < 0x20 || c > 0x7e;
const FRAGMENT_SET: EncodeSet = (c) => C0_CONTROL(c) || c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
const QUERY_SET: EncodeSet = (c) => C0_CONTROL(c) || c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e;
const SPECIAL_QUERY_SET: EncodeSet = (c) => QUERY_SET(c) || c === 0x27;
const PATH_SET: EncodeSet = (c) => QUERY_SET(c) || c === 0x3f || c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7d;
const USERINFO_SET: EncodeSet = (c) => PATH_SET(c) || c === 0x2f || c === 0x3a || c === 0x3b || c === 0x3d || c === 0x40 || (c >= 0x5b && c <= 0x5d) || c === 0x7c;
const COMPONENT_SET: EncodeSet = (c) => USERINFO_SET(c) || (c >= 0x24 && c <= 0x26) || c === 0x2b || c === 0x2c;
const FORM_SET: EncodeSet = (c) => COMPONENT_SET(c) || c === 0x21 || (c >= 0x27 && c <= 0x29) || c === 0x7e;
/** `s` with the code points in `set` (and every non-ASCII one) percent-encoded as UTF-8. */
function percentEncode(s: string, set: EncodeSet, spaceAsPlus: boolean = false): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (spaceAsPlus && c === 0x20) out += "+";
      else if (set(c)) out += "%" + HEX[c];
      else out += s[i];
      continue;
    }
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
      else cp = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) cp = 0xfffd;
    if (cp < 0x800) out += "%" + HEX[0xc0 | (cp >> 6)] + "%" + HEX[0x80 | (cp & 0x3f)];
    else if (cp < 0x10000) out += "%" + HEX[0xe0 | (cp >> 12)] + "%" + HEX[0x80 | ((cp >> 6) & 0x3f)] + "%" + HEX[0x80 | (cp & 0x3f)];
    else out += "%" + HEX[0xf0 | (cp >> 18)] + "%" + HEX[0x80 | ((cp >> 12) & 0x3f)] + "%" + HEX[0x80 | ((cp >> 6) & 0x3f)] + "%" + HEX[0x80 | (cp & 0x3f)];
  }
  return out;
}
function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}
/** UTF-8 bytes decoded with U+FFFD for each invalid sequence. */
function utf8Decode(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
    let need = 0, cp = 0, min = 0;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; cp = b & 0x0f; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; cp = b & 0x07; min = 0x10000; }
    else { out += "�"; i++; continue; }
    let j = 1;
    for (; j <= need && i + j < bytes.length; j++) {
      const t = bytes[i + j];
      if ((t & 0xc0) !== 0x80) break;
      cp = (cp << 6) | (t & 0x3f);
    }
    if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += "�"; i += Math.max(1, j - 1 < 1 ? 1 : j - 1); continue; }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}
/** %XX sequences decoded to bytes (an invalid one stays), '+' a space when asked, as a string. */
function percentDecode(s: string, plusAsSpace: boolean = false): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25 && i + 2 < s.length + 0) {
      const hi = hexValue(s.charCodeAt(i + 1)), lo = hexValue(s.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) { bytes.push(hi * 16 + lo); i += 2; continue; }
    }
    if (plusAsSpace && c === 0x2b) { bytes.push(0x20); continue; }
    if (c < 0x80) { bytes.push(c); continue; }
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
      else cp = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) cp = 0xfffd;
    if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return utf8Decode(bytes);
}

// ---- schemes and hosts ----
/** The default port of a special scheme (null for file), undefined for another scheme. */
function specialPort(scheme: string): number | null | undefined {
  switch (scheme) {
    case "ftp": return 21;
    case "file": return null;
    case "http": case "ws": return 80;
    case "https": case "wss": return 443;
    default: return undefined;
  }
}
function isSpecial(scheme: string): boolean { return specialPort(scheme) !== undefined; }
function isForbiddenHost(c: number): boolean {
  return c === 0 || c === 9 || c === 10 || c === 13 || c === 32 || c === 0x23 || c === 0x2f || c === 0x3a || c === 0x3c ||
    c === 0x3e || c === 0x3f || c === 0x40 || c === 0x5b || c === 0x5c || c === 0x5d || c === 0x5e || c === 0x7c;
}
function isForbiddenDomain(c: number): boolean { return isForbiddenHost(c) || c < 0x20 || c === 0x25 || c === 0x7f; }
function isDigit(c: number): boolean { return c >= 48 && c <= 57; }
function isHex(c: number): boolean { return hexValue(c) >= 0; }
function parseIPv4Number(s: string): number | null {
  if (s === "") return null;
  let radix = 10;
  let t = s;
  if (t.length >= 2 && (t.startsWith("0x") || t.startsWith("0X"))) { t = t.slice(2); radix = 16; }
  else if (t.length >= 2 && t[0] === "0") { t = t.slice(1); radix = 8; }
  if (t === "") return 0;
  const ok = radix === 10 ? /^[0-9]+$/.test(t) : radix === 16 ? /^[0-9A-Fa-f]+$/.test(t) : /^[0-7]+$/.test(t);
  if (!ok) return null;
  return parseInt(t, radix);
}
function endsInNumber(s: string): boolean {
  const parts = s.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1];
  if (last !== "" && /^[0-9]+$/.test(last)) return true;
  return /^0[xX][0-9A-Fa-f]*$/.test(last);
}
function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIPv4Number(p);
    if (n === null) return null;
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
  const last = nums[nums.length - 1];
  if (last >= Math.pow(256, 5 - nums.length)) return null;
  let ipv4 = last;
  for (let i = 0; i < nums.length - 1; i++) ipv4 += nums[i] * Math.pow(256, 3 - i);
  return ipv4;
}
function serializeIPv4(n: number): string {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) { out.unshift(n % 256); n = Math.floor(n / 256); }
  return out.join(".");
}
function parseIPv6(input: string): number[] | null {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let pieceIndex = 0;
  let compress = -1;
  let p = 0;
  const len = input.length;
  const at = (i: number): number => (i < len ? input.charCodeAt(i) : -1);
  if (at(p) === 0x3a) {
    if (at(p + 1) !== 0x3a) return null;
    p += 2; pieceIndex++; compress = pieceIndex;
  }
  while (p < len) {
    if (pieceIndex === 8) return null;
    if (at(p) === 0x3a) {
      if (compress !== -1) return null;
      p++; pieceIndex++; compress = pieceIndex;
      continue;
    }
    let value = 0, length = 0;
    while (length < 4 && isHex(at(p))) { value = value * 16 + hexValue(at(p)); p++; length++; }
    if (at(p) === 0x2e) {
      if (length === 0) return null;
      p -= length;
      if (pieceIndex > 6) return null;
      let numbersSeen = 0;
      while (p < len) {
        let ipv4Piece = -1;
        if (numbersSeen > 0) {
          if (at(p) === 0x2e && numbersSeen < 4) p++;
          else return null;
        }
        if (!isDigit(at(p))) return null;
        while (isDigit(at(p))) {
          const n = at(p) - 48;
          if (ipv4Piece === -1) ipv4Piece = n;
          else if (ipv4Piece === 0) return null;
          else ipv4Piece = ipv4Piece * 10 + n;
          if (ipv4Piece > 255) return null;
          p++;
        }
        address[pieceIndex] = address[pieceIndex] * 256 + ipv4Piece;
        numbersSeen++;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
      }
      if (numbersSeen !== 4) return null;
      break;
    } else if (at(p) === 0x3a) {
      p++;
      if (p >= len) return null;
    } else if (p < len) return null;
    address[pieceIndex] = value;
    pieceIndex++;
  }
  if (compress !== -1) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const t = address[compress + swaps - 1];
      address[compress + swaps - 1] = address[pieceIndex];
      address[pieceIndex] = t;
      pieceIndex--; swaps--;
    }
  } else if (pieceIndex !== 8) return null;
  return address;
}
function serializeIPv6(a: number[]): string {
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (a[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && a[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) bestStart = -1;
  let out = "";
  let skipping = false;
  for (let i = 0; i < 8; i++) {
    if (skipping && a[i] === 0) continue;
    if (skipping) skipping = false;
    if (bestStart === i) { out += i === 0 ? "::" : ":"; skipping = true; continue; }
    out += a[i].toString(16);
    if (i !== 7) out += ":";
  }
  return out;
}
/** The host parser: null for failure. */
function parseHost(input: string, special: boolean): string | null {
  if (input.startsWith("[")) {
    if (!input.endsWith("]")) return null;
    const v6 = parseIPv6(input.slice(1, -1));
    return v6 === null ? null : "[" + serializeIPv6(v6) + "]";
  }
  if (!special) {
    for (let i = 0; i < input.length; i++) if (isForbiddenHost(input.charCodeAt(i))) return null;
    return percentEncode(input, C0_CONTROL);
  }
  const domain = percentDecode(input).toLowerCase();
  if (domain === "") return null;
  for (let i = 0; i < domain.length; i++) {
    const c = domain.charCodeAt(i);
    if (c > 0x7e || isForbiddenDomain(c)) return null;   // no IDNA: a non-ASCII host is invalid here
  }
  if (endsInNumber(domain)) {
    const v4 = parseIPv4(domain);
    return v4 === null ? null : serializeIPv4(v4);
  }
  return domain;
}

// ---- the parser ----
function emptyRecord(): UrlRecord {
  return { scheme: "", username: "", password: "", host: null, port: null, path: [], opaque: null, query: null, fragment: null };
}
function isDriveLetter(s: string, normalized: boolean): boolean {
  return s.length === 2 && /^[A-Za-z]$/.test(s[0]) && (s[1] === ":" || (!normalized && s[1] === "|"));
}
function shortenPath(u: UrlRecord): void {
  if (u.scheme === "file" && u.path.length === 1 && isDriveLetter(u.path[0], true)) return;
  u.path.pop();
}
function copyAuthority(from: UrlRecord, to: UrlRecord): void {
  to.username = from.username; to.password = from.password; to.host = from.host; to.port = from.port;
}
/** The query and the fragment of `rest` (which starts at "?" or "#", or is empty). */
function parseQueryFragment(rest: string, u: UrlRecord): void {
  if (rest.startsWith("?")) {
    const hash = rest.indexOf("#");
    const q = hash < 0 ? rest.slice(1) : rest.slice(1, hash);
    u.query = percentEncode(q, isSpecial(u.scheme) ? SPECIAL_QUERY_SET : QUERY_SET);
    rest = hash < 0 ? "" : rest.slice(hash);
  }
  if (rest.startsWith("#")) u.fragment = percentEncode(rest.slice(1), FRAGMENT_SET);
}
/** The path segments of `s` appended to u.path (dot segments resolved); the
 *  query and fragment after them unless `pathOnly` (the pathname setter). */
function parsePath(s: string, u: UrlRecord, pathOnly: boolean): void {
  const special = isSpecial(u.scheme);
  let pathPart = s;
  let rest = "";
  if (!pathOnly) {
    const q = s.indexOf("?"), h = s.indexOf("#");
    let end = s.length;
    if (q >= 0) end = q;
    if (h >= 0 && h < end) end = h;
    pathPart = s.slice(0, end);
    rest = s.slice(end);
  }
  let entered = special || pathPart !== "";
  if (pathPart.startsWith("/") || (special && pathPart.startsWith("\\"))) { pathPart = pathPart.slice(1); entered = true; }
  if (entered) {
    const segs = special ? pathPart.split(/[\/\\]/) : pathPart.split("/");
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const last = i === segs.length - 1;
      const lower = seg.toLowerCase();
      if (lower === ".." || lower === ".%2e" || lower === "%2e." || lower === "%2e%2e") {
        shortenPath(u);
        if (last) u.path.push("");
      } else if (lower === "." || lower === "%2e") {
        if (last) u.path.push("");
      } else {
        let text = seg;
        if (u.scheme === "file" && u.path.length === 0 && isDriveLetter(text, false)) text = text[0] + ":";
        u.path.push(percentEncode(text, PATH_SET));
      }
    }
  }
  if (!pathOnly) parseQueryFragment(rest, u);
}
/** The authority ("user:pass@host:port"), then the path, query and fragment. */
function parseAuthority(rest: string, u: UrlRecord): UrlRecord | null {
  const special = isSpecial(u.scheme);
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c === 0x2f || c === 0x3f || c === 0x23 || (special && c === 0x5c)) { end = i; break; }
  }
  const authority = rest.slice(0, end);
  const after = rest.slice(end);
  let hostPort = authority;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    hostPort = authority.slice(at + 1);
    const colon = userinfo.indexOf(":");
    if (colon >= 0) {
      u.username = percentEncode(userinfo.slice(0, colon), USERINFO_SET);
      u.password = percentEncode(userinfo.slice(colon + 1), USERINFO_SET);
    } else u.username = percentEncode(userinfo, USERINFO_SET);
  }
  let hostStr = hostPort;
  let portStr: string | null = null;
  const close = hostPort.lastIndexOf("]");
  const colon = hostPort.lastIndexOf(":");
  if (colon > close) { hostStr = hostPort.slice(0, colon); portStr = hostPort.slice(colon + 1); }
  if (special && hostStr === "") return null;
  if (!special && hostStr === "" && (u.username !== "" || u.password !== "" || (portStr !== null && portStr !== ""))) return null;
  if (portStr !== null && portStr !== "") {
    if (!/^[0-9]+$/.test(portStr)) return null;
    const p = parseInt(portStr, 10);
    if (p > 65535) return null;
    u.port = specialPort(u.scheme) === p ? null : p;
  }
  if (hostStr === "" && !special) u.host = "";
  else {
    const h = parseHost(hostStr, special);
    if (h === null) return null;
    u.host = u.scheme === "file" && h === "localhost" ? "" : h;
  }
  parsePath(after, u, false);
  return u;
}
function parseFile(rest: string, base: UrlRecord | null, u: UrlRecord): UrlRecord | null {
  u.scheme = "file";
  u.host = "";
  const c0 = rest.charCodeAt(0), c1 = rest.charCodeAt(1);
  const slash = (c: number): boolean => c === 0x2f || c === 0x5c;
  if (slash(c0)) {
    if (slash(c1)) {
      // file host: "file://host/path"
      const r = rest.slice(2);
      let end = r.length;
      for (let i = 0; i < r.length; i++) { const c = r.charCodeAt(i); if (c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) { end = i; break; } }
      const hostStr = r.slice(0, end);
      if (isDriveLetter(hostStr, false)) { parsePath(r, u, false); return u; }
      if (hostStr !== "") {
        const h = parseHost(hostStr, true);
        if (h === null) return null;
        u.host = h === "localhost" ? "" : h;
      }
      parsePath(r.slice(end), u, false);
      return u;
    }
    if (base !== null && base.scheme === "file") {
      u.host = base.host;
      if (base.path.length > 0 && isDriveLetter(base.path[0], true) && !isDriveLetter(rest.slice(1, 3), false)) u.path.push(base.path[0]);
    }
    parsePath(rest, u, false);
    return u;
  }
  if (base !== null && base.scheme === "file") {
    u.host = base.host;
    if (rest === "") { u.path = base.path.slice(); u.query = base.query; return u; }
    if (rest.startsWith("?")) { u.path = base.path.slice(); parseQueryFragment(rest, u); return u; }
    if (rest.startsWith("#")) { u.path = base.path.slice(); u.query = base.query; parseQueryFragment(rest, u); return u; }
    u.path = base.path.slice();
    shortenPath(u);
    parsePath(rest, u, false);
    return u;
  }
  parsePath(rest, u, false);
  return u;
}
/** The basic URL parser: a record, or null for failure. */
function basicParse(raw: string, base: UrlRecord | null): UrlRecord | null {
  let start = 0, end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 0x20) start++;
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end--;
  const input = raw.slice(start, end).replace(/[\t\n\r]/g, "");
  const u = emptyRecord();
  const m = /^([A-Za-z][A-Za-z0-9+\-.]*):/.exec(input);
  let rest: string;
  if (m !== null) {
    u.scheme = m[1].toLowerCase();
    rest = input.slice(m[0].length);
    if (u.scheme === "file") return parseFile(rest, base, u);
    if (isSpecial(u.scheme)) {
      if (!(base !== null && base.scheme === u.scheme && !/^[\/\\]{2}/.test(rest))) {
        return parseAuthority(rest.replace(/^[\/\\]+/, ""), u);
      }
      // the same special scheme as the base, no authority: a relative reference
    } else {
      if (rest.startsWith("//")) return parseAuthority(rest.slice(2), u);
      if (rest.startsWith("/")) { parsePath(rest, u, false); return u; }
      // an opaque path
      const q = rest.indexOf("?"), h = rest.indexOf("#");
      let pend = rest.length;
      if (q >= 0) pend = q;
      if (h >= 0 && h < pend) pend = h;
      u.opaque = percentEncode(rest.slice(0, pend), C0_CONTROL);
      parseQueryFragment(rest.slice(pend), u);
      return u;
    }
  } else {
    if (base === null) return null;
    u.scheme = base.scheme;
    rest = input;
  }
  // relative to the base
  if (base === null) return null;
  if (base.opaque !== null) {
    if (!rest.startsWith("#")) return null;
    u.opaque = base.opaque; u.query = base.query;
    parseQueryFragment(rest, u);
    return u;
  }
  if (u.scheme === "file") return parseFile(rest, base, u);
  const special = isSpecial(u.scheme);
  const c0 = rest.charCodeAt(0), c1 = rest.charCodeAt(1);
  const slash = (c: number): boolean => c === 0x2f || (special && c === 0x5c);
  if (slash(c0)) {
    if (slash(c1)) return parseAuthority(special ? rest.replace(/^[\/\\]+/, "") : rest.slice(2), u);
    copyAuthority(base, u);
    parsePath(rest, u, false);
    return u;
  }
  copyAuthority(base, u);
  u.path = base.path.slice();
  if (rest === "") { u.query = base.query; return u; }
  if (rest.startsWith("?")) { parseQueryFragment(rest, u); return u; }
  if (rest.startsWith("#")) { u.query = base.query; parseQueryFragment(rest, u); return u; }
  shortenPath(u);
  parsePath(rest, u, false);
  return u;
}
function pathnameOf(u: UrlRecord): string {
  if (u.opaque !== null) return u.opaque;
  let s = "";
  for (const seg of u.path) s += "/" + seg;
  return s;
}
function serialize(u: UrlRecord, excludeFragment: boolean = false): string {
  let out = u.scheme + ":";
  if (u.host !== null) {
    out += "//";
    if (u.username !== "" || u.password !== "") {
      out += u.username;
      if (u.password !== "") out += ":" + u.password;
      out += "@";
    }
    out += u.host;
    if (u.port !== null) out += ":" + u.port;
  } else if (u.opaque === null && u.path.length > 1 && u.path[0] === "") out += "/.";
  out += pathnameOf(u);
  if (u.query !== null) out += "?" + u.query;
  if (!excludeFragment && u.fragment !== null) out += "#" + u.fragment;
  return out;
}
function cannotHaveCredentials(u: UrlRecord): boolean { return u.host === null || u.host === "" || u.scheme === "file"; }
function invalidUrl(input: string, base?: string): TypeError {
  const e = codedTypeError("ERR_INVALID_URL", "Invalid URL") as unknown as TypeError & { input: string; base?: string };
  e.input = input;
  if (base !== undefined) e.base = base;
  return e;
}

export class URL {
  private rec: UrlRecord;
  private params: URLSearchParams | null = null;
  constructor(input: string | URL, base?: string | URL) {
    const text = String(input);
    let baseRec: UrlRecord | null = null;
    if (base !== undefined) {
      const baseText = String(base);
      baseRec = basicParse(baseText, null);
      if (baseRec === null) throw invalidUrl(text, baseText);
    }
    const rec = basicParse(text, baseRec);
    if (rec === null) throw invalidUrl(text, base === undefined ? undefined : String(base));
    this.rec = rec;
  }
  static canParse(input: string | URL, base?: string | URL): boolean {
    try { new URL(input, base); return true; } catch { return false; }
  }
  static parse(input: string | URL, base?: string | URL): URL | null {
    try { return new URL(input, base); } catch { return null; }
  }
  get href(): string { return serialize(this.rec); }
  set href(value: string) {
    const text = String(value);
    const rec = basicParse(text, null);
    if (rec === null) throw invalidUrl(text);
    this.rec = rec;
    this.syncParams();
  }
  get origin(): string {
    const u = this.rec;
    switch (u.scheme) {
      case "blob": {
        const inner = URL.parse(pathnameOf(u));
        if (inner !== null && (inner.rec.scheme === "http" || inner.rec.scheme === "https")) return inner.origin;
        return "null";
      }
      case "ftp": case "http": case "https": case "ws": case "wss":
        return u.scheme + "://" + u.host + (u.port === null ? "" : ":" + u.port);
      default:
        return "null";
    }
  }
  get protocol(): string { return this.rec.scheme + ":"; }
  set protocol(value: string) {
    const u = this.rec;
    const text = String(value);
    const colon = text.indexOf(":");
    const candidate = (colon >= 0 ? text.slice(0, colon) : text).toLowerCase();
    if (!/^[a-z][a-z0-9+\-.]*$/.test(candidate)) return;
    if (isSpecial(u.scheme) !== isSpecial(candidate)) return;
    if (candidate === "file" && (u.username !== "" || u.password !== "" || u.port !== null)) return;
    if (u.scheme === "file" && u.host === "") return;
    u.scheme = candidate;
    if (u.port !== null && specialPort(candidate) === u.port) u.port = null;
  }
  get username(): string { return this.rec.username; }
  set username(value: string) {
    if (cannotHaveCredentials(this.rec)) return;
    this.rec.username = percentEncode(String(value), USERINFO_SET);
  }
  get password(): string { return this.rec.password; }
  set password(value: string) {
    if (cannotHaveCredentials(this.rec)) return;
    this.rec.password = percentEncode(String(value), USERINFO_SET);
  }
  get host(): string {
    const u = this.rec;
    if (u.host === null) return "";
    return u.port === null ? u.host : u.host + ":" + u.port;
  }
  set host(value: string) { this.setHost(String(value), true); }
  get hostname(): string { return this.rec.host === null ? "" : this.rec.host; }
  set hostname(value: string) { this.setHost(String(value), false); }
  private setHost(text: string, withPort: boolean): void {
    const u = this.rec;
    if (u.opaque !== null) return;
    const special = isSpecial(u.scheme);
    let end = text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x2f || c === 0x3f || c === 0x23 || (special && c === 0x5c)) { end = i; break; }
    }
    const hostPort = text.slice(0, end);
    let hostStr = hostPort;
    let portStr: string | null = null;
    const close = hostPort.lastIndexOf("]");
    const colon = hostPort.lastIndexOf(":");
    if (colon > close) {
      if (!withPort) return;   // the hostname setter stops at a port
      hostStr = hostPort.slice(0, colon);
      portStr = hostPort.slice(colon + 1);
    }
    if (hostStr === "") {
      if (special || u.username !== "" || u.password !== "" || u.port !== null) return;
      u.host = "";
      return;
    }
    const h = parseHost(hostStr, special);
    if (h === null) return;
    u.host = u.scheme === "file" && h === "localhost" ? "" : h;
    if (portStr !== null && portStr !== "" && u.scheme !== "file") {
      const m = /^[0-9]+/.exec(portStr);
      if (m !== null) {
        const p = parseInt(m[0], 10);
        if (p <= 65535) u.port = specialPort(u.scheme) === p ? null : p;
      }
    }
  }
  get port(): string { return this.rec.port === null ? "" : String(this.rec.port); }
  set port(value: string | number) {
    const u = this.rec;
    if (cannotHaveCredentials(u)) return;
    const text = String(value);
    if (text === "") { u.port = null; return; }
    const m = /^[0-9]+/.exec(text);
    if (m === null) return;
    const p = parseInt(m[0], 10);
    if (p > 65535) return;
    u.port = specialPort(u.scheme) === p ? null : p;
  }
  get pathname(): string { return pathnameOf(this.rec); }
  set pathname(value: string) {
    const u = this.rec;
    if (u.opaque !== null) return;
    u.path = [];
    parsePath(String(value), u, true);
  }
  get search(): string {
    const q = this.rec.query;
    return q === null || q === "" ? "" : "?" + q;
  }
  set search(value: string) {
    const u = this.rec;
    let text = String(value);
    if (text === "") { u.query = null; this.syncParams(); return; }
    if (text[0] === "?") text = text.slice(1);
    u.query = percentEncode(text, isSpecial(u.scheme) ? SPECIAL_QUERY_SET : QUERY_SET);
    this.syncParams();
  }
  get searchParams(): URLSearchParams {
    if (this.params === null) {
      this.params = new URLSearchParams(this.rec.query === null ? "" : this.rec.query);
      this.params.attach(this);
    }
    return this.params;
  }
  get hash(): string {
    const f = this.rec.fragment;
    return f === null || f === "" ? "" : "#" + f;
  }
  set hash(value: string) {
    let text = String(value);
    if (text === "") { this.rec.fragment = null; return; }
    if (text[0] === "#") text = text.slice(1);
    this.rec.fragment = percentEncode(text, FRAGMENT_SET);
  }
  toString(): string { return serialize(this.rec); }
  toJSON(): string { return serialize(this.rec); }
  /** The searchParams object writes its serialization back here. */
  setQueryFromParams(serialized: string): void {
    this.rec.query = serialized === "" ? null : serialized;
  }
  private syncParams(): void {
    if (this.params !== null) this.params.reset(this.rec.query === null ? "" : this.rec.query);
  }
}

function parseForm(s: string): [string, string][] {
  const out: [string, string][] = [];
  if (s === "") return out;
  for (const piece of s.split("&")) {
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const name = eq < 0 ? piece : piece.slice(0, eq);
    const value = eq < 0 ? "" : piece.slice(eq + 1);
    out.push([percentDecode(name, true), percentDecode(value, true)]);
  }
  return out;
}
function formEncode(s: string): string { return percentEncode(s, FORM_SET, true); }

export type URLSearchParamsInit = string | URLSearchParams | { [key: string]: string } | Iterable<[string, string]> | [string, string][];
export class URLSearchParams {
  private list: [string, string][] = [];
  private url: URL | null = null;
  constructor(init?: URLSearchParamsInit | null) {
    if (init === undefined || init === null) return;
    if (typeof init === "object" || typeof init === "function") {
      if (init instanceof URLSearchParams) { this.list = init.list.map((p): [string, string] => [p[0], p[1]]); return; }
      const iterable = init as { [Symbol.iterator]?: unknown };
      if (typeof iterable[Symbol.iterator] === "function") {
        for (const pair of init as Iterable<unknown>) {
          if (typeof pair !== "object" || pair === null || typeof (pair as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
            throw codedTypeError("ERR_INVALID_TUPLE", "Each query pair must be an iterable [name, value] tuple");
          }
          const items = [...(pair as Iterable<unknown>)];
          if (items.length !== 2) throw codedTypeError("ERR_INVALID_TUPLE", "Each query pair must be an iterable [name, value] tuple");
          this.list.push([String(items[0]), String(items[1])]);
        }
        return;
      }
      const record = init as { [key: string]: unknown };
      for (const key of Object.keys(record)) this.list.push([key, String(record[key])]);
      return;
    }
    let text = String(init);
    if (text[0] === "?") text = text.slice(1);
    this.list = parseForm(text);
  }
  /** @internal The URL whose query this object mirrors. */
  attach(url: URL): void { this.url = url; }
  /** @internal The URL's query changed. */
  reset(query: string): void { this.list = parseForm(query); }
  private update(): void {
    if (this.url !== null) this.url.setQueryFromParams(this.toString());
  }
  append(name: string, value: string): void {
    this.list.push([String(name), String(value)]);
    this.update();
  }
  delete(name: string, value?: string): void {
    const n = String(name);
    if (value !== undefined) {
      const v = String(value);
      this.list = this.list.filter((p) => !(p[0] === n && p[1] === v));
    } else this.list = this.list.filter((p) => p[0] !== n);
    this.update();
  }
  get(name: string): string | null {
    const n = String(name);
    for (const p of this.list) if (p[0] === n) return p[1];
    return null;
  }
  getAll(name: string): string[] {
    const n = String(name);
    const out: string[] = [];
    for (const p of this.list) if (p[0] === n) out.push(p[1]);
    return out;
  }
  has(name: string, value?: string): boolean {
    const n = String(name);
    if (value !== undefined) {
      const v = String(value);
      for (const p of this.list) if (p[0] === n && p[1] === v) return true;
      return false;
    }
    for (const p of this.list) if (p[0] === n) return true;
    return false;
  }
  set(name: string, value: string): void {
    const n = String(name), v = String(value);
    const out: [string, string][] = [];
    let found = false;
    for (const p of this.list) {
      if (p[0] === n) {
        if (!found) { out.push([n, v]); found = true; }
      } else out.push(p);
    }
    if (!found) out.push([n, v]);
    this.list = out;
    this.update();
  }
  /** Sorts by name, keeping the order of equal names. */
  sort(): void {
    const indexed = this.list.map((p, i): [[string, string], number] => [p, i]);
    indexed.sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]));
    this.list = indexed.map((x) => x[0]);
    this.update();
  }
  get size(): number { return this.list.length; }
  forEach(callback: (value: string, name: string, searchParams: URLSearchParams) => void, thisArg?: unknown): void {
    if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    for (let i = 0; i < this.list.length; i++) callback.call(thisArg, this.list[i][1], this.list[i][0], this);
  }
  *entries(): IterableIterator<[string, string]> {
    for (let i = 0; i < this.list.length; i++) yield [this.list[i][0], this.list[i][1]];
  }
  *keys(): IterableIterator<string> {
    for (let i = 0; i < this.list.length; i++) yield this.list[i][0];
  }
  *values(): IterableIterator<string> {
    for (let i = 0; i < this.list.length; i++) yield this.list[i][1];
  }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries(); }
  toString(): string {
    let out = "";
    for (let i = 0; i < this.list.length; i++) {
      if (i > 0) out += "&";
      out += formEncode(this.list[i][0]) + "=" + formEncode(this.list[i][1]);
    }
    return out;
  }
}

// ---- file URLs ----
export function fileURLToPath(url: string | URL, _options?: { windows?: boolean }): string {
  let u: URL;
  if (typeof url === "string") u = new URL(url);
  else if (url instanceof URL) u = url;
  else throw invalidArgType("path", "of type string or an instance of URL", url);
  if (u.protocol !== "file:") throw codedTypeError("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
  if (u.hostname !== "") throw codedTypeError("ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty on ${nodeHost.platform}`);
  const pathname = u.pathname;
  for (let i = 0; i < pathname.length; i++) {
    if (pathname[i] === "%") {
      const third = pathname.charCodeAt(i + 2) | 0x20;
      if (pathname[i + 1] === "2" && third === 102) throw codedTypeError("ERR_INVALID_FILE_URL_PATH", "File URL path must not include encoded / characters");
    }
  }
  return decodeURIComponent(pathname);
}
export function pathToFileURL(filepath: string, _options?: { windows?: boolean }): URL {
  if (typeof filepath !== "string") throw invalidArgType("path", "of type string", filepath);
  let resolved = resolvePath(filepath);
  if (filepath.endsWith("/") && !resolved.endsWith("/")) resolved += "/";
  resolved = resolved.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/\t/g, "%09")
    .replace(/\?/g, "%3F").replace(/#/g, "%23");
  const out = new URL("file://");
  out.pathname = resolved;
  return out;
}
export function domainToASCII(domain: string): string {
  const h = parseHost(String(domain), true);
  return h === null ? "" : h;
}
export function domainToUnicode(domain: string): string { return domainToASCII(domain); }
export interface UrlHttpOptions {
  protocol: string; hostname: string; hash: string; search: string; pathname: string; path: string; href: string; port?: number; auth?: string;
}
export function urlToHttpOptions(url: URL): UrlHttpOptions {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const options: UrlHttpOptions = {
    protocol: url.protocol, hostname, hash: url.hash, search: url.search, pathname: url.pathname,
    path: `${url.pathname}${url.search}`, href: url.href,
  };
  if (url.port !== "") options.port = Number(url.port);
  if (url.username !== "" || url.password !== "") options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return options;
}

// ---- the legacy API ----
export class Url {
  protocol: string | null = null;
  slashes: boolean | null = null;
  auth: string | null = null;
  host: string | null = null;
  port: string | null = null;
  hostname: string | null = null;
  hash: string | null = null;
  search: string | null = null;
  query: string | ParsedUrlQuery | null = null;
  pathname: string | null = null;
  path: string | null = null;
  href: string = "";
}
const SLASHED = ["http:", "https:", "ftp:", "gopher:", "file:", "ws:", "wss:"];
function isSlashed(protocol: string): boolean { return SLASHED.indexOf(protocol) >= 0; }
/** Characters the legacy parser escapes in a path. */
function autoEscape(s: string): string {
  return s.replace(/[<>"` \r\n\t{}|\\^']/g, (c) => "%" + HEX[c.charCodeAt(0)]);
}
export function parse(urlString: string, parseQuery: boolean = false, slashesDenoteHost: boolean = false): Url {
  if (typeof urlString !== "string") throw invalidArgType("url", "of type string", urlString);
  const result = new Url();
  let rest = urlString.trim().replace(/\\/g, "/");
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) { result.hash = rest.slice(hashAt); rest = rest.slice(0, hashAt); }
  const qAt = rest.indexOf("?");
  if (qAt >= 0) {
    result.search = rest.slice(qAt);
    result.query = parseQuery ? parseQueryString(rest.slice(qAt + 1)) : rest.slice(qAt + 1);
    rest = rest.slice(0, qAt);
  } else if (parseQuery) {
    result.search = "";
    result.query = Object.create(null) as ParsedUrlQuery;
  }
  const protoMatch = /^([a-zA-Z0-9.+-]+:)/.exec(rest);
  let lowerProto = "";
  if (protoMatch !== null) {
    lowerProto = protoMatch[1].toLowerCase();
    result.protocol = lowerProto;
    rest = rest.slice(protoMatch[1].length);
  }
  let slashes = false;
  if (slashesDenoteHost || protoMatch !== null || /^\/\/[^@\/]+@[^@\/]+/.test(rest)) {
    slashes = rest.startsWith("//");
    if (slashes && lowerProto !== "javascript:") { rest = rest.slice(2); result.slashes = true; }
  }
  if (lowerProto !== "javascript:" && (slashes || (protoMatch !== null && !isSlashed(lowerProto)))) {
    let hostEnd = rest.length;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === "/" || c === "?" || c === "#" || c === ";") { hostEnd = i; break; }
    }
    const atSign = rest.lastIndexOf("@", hostEnd - 1);
    if (atSign >= 0) {
      result.auth = decodeURIComponent(rest.slice(0, atSign));
      rest = rest.slice(atSign + 1);
      hostEnd -= atSign + 1;
    }
    for (let i = 0; i < hostEnd; i++) {
      const c = rest[i];
      if (c === "%" || c === "<" || c === ">" || c === '"' || c === "`" || c === " " || c === "\r" || c === "\n" || c === "\t" || c === "{" || c === "}" || c === "|" || c === "^" || c === "'") { hostEnd = i; break; }
    }
    let hostStr = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);
    const portMatch = /:([0-9]*)$/.exec(hostStr);
    if (portMatch !== null) {
      if (portMatch[1] !== "") result.port = portMatch[1];
      hostStr = hostStr.slice(0, hostStr.length - portMatch[0].length);
    }
    let hostname = hostStr.toLowerCase();
    const ipv6 = hostname.startsWith("[") && hostname.endsWith("]");
    if (ipv6) hostname = hostname.slice(1, -1);
    result.hostname = hostname;
    result.host = (ipv6 ? "[" + hostname + "]" : hostname) + (result.port === null ? "" : ":" + result.port);
    if (isSlashed(lowerProto) && hostname !== "" && rest === "") rest = "/";
  }
  if (rest !== "") result.pathname = autoEscape(rest);
  if (result.pathname !== null || result.search !== null) result.path = (result.pathname === null ? "" : result.pathname) + (result.search === null ? "" : result.search);
  result.href = format(result);
  return result;
}
export interface FormatUrlOptions { auth?: boolean; fragment?: boolean; search?: boolean; unicode?: boolean }
export interface UrlObject {
  protocol?: string | null; slashes?: boolean | null; auth?: string | null; host?: string | null; port?: string | number | null;
  hostname?: string | null; hash?: string | null; search?: string | null; query?: string | ParsedUrlQuery | null; pathname?: string | null; href?: string | null;
}
export function format(urlObject: UrlObject | URL | string, options?: FormatUrlOptions): string {
  if (typeof urlObject === "string") urlObject = parse(urlObject);
  if (urlObject instanceof URL) {
    const auth = options === undefined || options.auth !== false;
    const fragment = options === undefined || options.fragment !== false;
    const search = options === undefined || options.search !== false;
    let out = urlObject.protocol;
    if (urlObject.host !== "") {
      out += "//";
      if (auth && (urlObject.username !== "" || urlObject.password !== "")) {
        out += urlObject.username;
        if (urlObject.password !== "") out += ":" + urlObject.password;
        out += "@";
      }
      out += urlObject.host;
    }
    out += urlObject.pathname;
    if (search) out += urlObject.search;
    if (fragment) out += urlObject.hash;
    return out;
  }
  if (typeof urlObject !== "object" || urlObject === null) throw invalidArgType("urlObject", "one of type object or string", urlObject);
  const o = urlObject;
  let protocol = o.protocol === undefined || o.protocol === null ? "" : o.protocol;
  if (protocol !== "" && !protocol.endsWith(":")) protocol += ":";
  const auth = o.auth === undefined || o.auth === null || o.auth === "" ? "" : encodeURIComponent(o.auth).replace(/%3A/i, ":") + "@";
  let host = "";
  let hasHost = false;
  if (o.host !== undefined && o.host !== null) { host = auth + o.host; hasHost = true; }
  else if (o.hostname !== undefined && o.hostname !== null) {
    host = auth + (o.hostname.indexOf(":") >= 0 && !o.hostname.startsWith("[") ? "[" + o.hostname + "]" : o.hostname);
    if (o.port !== undefined && o.port !== null && o.port !== "") host += ":" + o.port;
    hasHost = true;
  }
  let pathname = o.pathname === undefined || o.pathname === null ? "" : o.pathname;
  let hash = o.hash === undefined || o.hash === null ? "" : o.hash;
  let search = o.search === undefined || o.search === null ? "" : o.search;
  if (search === "" && o.query !== undefined && o.query !== null && typeof o.query === "object") search = stringifyQuery(o.query as { [key: string]: string | string[] });
  if (search !== "" && search[0] !== "?") search = "?" + search;
  if (o.slashes || ((protocol === "" || isSlashed(protocol)) && hasHost)) {
    host = "//" + host;
    if (pathname !== "" && pathname[0] !== "/") pathname = "/" + pathname;
  }
  if (hash !== "" && hash[0] !== "#") hash = "#" + hash;
  pathname = pathname.replace(/[?#]/g, (c) => encodeURIComponent(c));
  search = search.replace(/#/g, "%23");
  return protocol + host + pathname + search + hash;
}
/** Dot segments of a legacy path resolved. */
function removeDots(path: string): string {
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/") || path.endsWith("/.") || path.endsWith("/..");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (out.length > 0) out.pop(); else if (!absolute) out.push(".."); continue; }
    out.push(seg);
  }
  let result = (absolute ? "/" : "") + out.join("/");
  if (trailing && !result.endsWith("/")) result += "/";
  return result;
}
export function resolve(from: string, to: string): string {
  const rel = parse(to);
  if (rel.protocol !== null) return rel.href;
  const base = parse(from);
  if (base.protocol !== null && base.host !== null && isSlashed(base.protocol)) {
    try { return new URL(to, from).href; } catch { /* the legacy merge below */ }
  }
  const basePath = base.pathname === null ? "" : base.pathname;
  let path: string;
  let search = rel.search, hash = rel.hash;
  if (to === "") { path = basePath; search = base.search; hash = base.hash; }
  else if (to.startsWith("/")) path = rel.pathname === null ? "/" : rel.pathname;
  else if (to.startsWith("?") || to.startsWith("#")) { path = basePath; if (to.startsWith("#")) search = base.search; }
  else {
    const dir = basePath.slice(0, basePath.lastIndexOf("/") + 1);
    path = dir + (rel.pathname === null ? "" : rel.pathname);
    if (base.host !== null && path !== "" && !path.startsWith("/")) path = "/" + path;
  }
  path = removeDots(path);
  const merged = new Url();
  merged.protocol = base.protocol; merged.slashes = base.slashes; merged.auth = base.auth; merged.host = base.host;
  merged.hostname = base.hostname; merged.port = base.port;
  merged.pathname = path === "" ? null : path;
  merged.search = search;
  merged.hash = hash;
  return format(merged);
}
const url = { URL, URLSearchParams, fileURLToPath, pathToFileURL, domainToASCII, domainToUnicode, urlToHttpOptions, parse, format, resolve, Url };
export default url;
