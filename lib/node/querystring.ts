// node:querystring (docs/node_compat_design.md): application/x-www-form-urlencoded
// strings as Node parses and builds them: repeated keys collect into arrays, '+'
// is a space, a sequence that is not valid percent-encoding is kept as it is,
// at most 1000 keys unless told otherwise, the result a prototype-less object.
import { Buffer } from "./buffer";

export interface ParsedUrlQuery { [key: string]: string | string[] | undefined }
export interface ParsedUrlQueryInput { [key: string]: string | number | boolean | bigint | ReadonlyArray<string | number | boolean | bigint> | null | undefined }
export interface ParseOptions { maxKeys?: number; decodeURIComponent?: (s: string) => string }
export interface StringifyOptions { encodeURIComponent?: (s: string) => string }

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}
/** The bytes of `s` with %XX sequences decoded (an invalid one is kept) and, when asked, '+' a space. */
export function unescapeBuffer(s: string, decodeSpaces: boolean = false): Buffer {
  const out: number[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending.length === 0) return;
    const bytes = Buffer.from(pending, "utf8");
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
    pending = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37 && i + 2 < s.length + 0) {
      const hi = hexValue(s.charCodeAt(i + 1)), lo = hexValue(s.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) { flush(); out.push(hi * 16 + lo); i += 2; continue; }
    }
    if (c === 43 && decodeSpaces) { flush(); out.push(32); continue; }
    pending += s[i];
  }
  flush();
  return Buffer.from(out);
}
/** decodeURIComponent, falling back to a lenient byte-wise decoding of a malformed string. */
export function unescape(s: string, decodeSpaces: boolean = false): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return unescapeBuffer(s, decodeSpaces).toString("utf8");
  }
}
/** Percent-encoding for a query component: A-Z a-z 0-9 - _ . ! ~ * ' ( ) stay. */
export function escape(str: unknown): string {
  let s: string;
  if (typeof str === "string") s = str;
  else if (typeof str === "object" && str !== null) s = String(str);
  else s = "" + str;
  return encodeURIComponent(s);
}
function stringifyPrimitive(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && isFinite(v)) return "" + v;
  if (typeof v === "bigint") return "" + v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}
export function stringify(obj?: ParsedUrlQueryInput | null, sep: string = "&", eq: string = "=", options?: StringifyOptions): string {
  if (!sep) sep = "&";
  if (!eq) eq = "=";
  const encode = options !== undefined && typeof options.encodeURIComponent === "function" ? options.encodeURIComponent : escape;
  if (obj === null || obj === undefined || typeof obj !== "object") return "";
  const parts: string[] = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const prefix = encode(stringifyPrimitive(key)) + eq;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(prefix + encode(stringifyPrimitive(item)));
    } else {
      parts.push(prefix + encode(stringifyPrimitive(value)));
    }
  }
  return parts.join(sep);
}
function decodeComponent(s: string, decode: (s: string) => string): string {
  try {
    return decode(s);
  } catch {
    return unescape(s, true);
  }
}
export function parse(str: string, sep: string = "&", eq: string = "=", options?: ParseOptions): ParsedUrlQuery {
  const result: ParsedUrlQuery = Object.create(null) as ParsedUrlQuery;
  if (typeof str !== "string" || str.length === 0) return result;
  if (!sep) sep = "&";
  if (!eq) eq = "=";
  let maxKeys = 1000;
  if (options !== undefined && typeof options.maxKeys === "number") maxKeys = options.maxKeys;
  const decode = options !== undefined && typeof options.decodeURIComponent === "function" ? options.decodeURIComponent : unescape;
  const customDecode = decode !== unescape;
  let pairs = str.split(sep);
  if (maxKeys > 0 && pairs.length > maxKeys) pairs = pairs.slice(0, maxKeys);
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const at = pair.indexOf(eq);
    let key: string, value: string;
    if (at >= 0) { key = pair.slice(0, at); value = pair.slice(at + eq.length); }
    else { key = pair; value = ""; }
    // '+' is a space; the default decoder sees it as one, a custom decoder gets the plain text
    key = key.replace(/\+/g, " ");
    value = value.replace(/\+/g, " ");
    if (key.indexOf("%") >= 0 || customDecode) key = decodeComponent(key, decode);
    if (value.indexOf("%") >= 0 || customDecode) value = decodeComponent(value, decode);
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}
export const decode = parse;
export const encode = stringify;
const querystring = { parse, stringify, decode, encode, escape, unescape, unescapeBuffer };
export default querystring;
