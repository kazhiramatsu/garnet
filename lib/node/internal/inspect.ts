// util.inspect's core: the runtime's console formatter for everything but a top-level
// string, which util.inspect quotes (console.log prints it raw).
import { host } from "../host";

/** Node's quoting of a string: single quotes unless the text has them. */
export function quoteString(s: string): string {
  let quote = "'";
  if (s.includes("'")) {
    if (!s.includes('"')) quote = '"';
    else if (!s.includes("`") && !s.includes("${")) quote = "`";
  }
  let out = quote;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === quote) out += "\\" + ch;
    else if (ch === "\\") out += "\\\\";
    else if (c === 10) out += "\\n";
    else if (c === 9) out += "\\t";
    else if (c === 13) out += "\\r";
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c === 11) out += "\\v";
    else if (c < 32 || c === 127) out += "\\x" + (c < 16 ? "0" : "") + c.toString(16).toUpperCase();
    else out += ch;
  }
  return out + quote;
}
export function inspectValue(value: unknown): string {
  if (typeof value === "string") return quoteString(value);
  return host.inspect(value);
}
