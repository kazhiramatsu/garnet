// escape and unescape (ECMA-262 Annex B.2.1): a program that names one compiles this. Methods: neither is a constructor.

const HEX = "0123456789ABCDEF";
function plain(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 || c === 42 || c === 95 || c === 43 || c === 45 || c === 46 || c === 47;
}
function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}
// the code unit the `n` hex digits at `at` spell, or -1
function hexAt(s: string, at: number, n: number): number {
  if (at + n > s.length) return -1;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = hexDigit(s.charCodeAt(at + i));
    if (d < 0) return -1;
    v = v * 16 + d;
  }
  return v;
}
const fns = {
  escape(string?: any): string {
    const s = `${string}`;
    let r = "";
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (plain(c)) r += s[k];
      else if (c < 256) r += "%" + HEX[c >> 4] + HEX[c & 15];
      else r += "%u" + HEX[c >> 12] + HEX[(c >> 8) & 15] + HEX[(c >> 4) & 15] + HEX[c & 15];
    }
    return r;
  },
  unescape(string?: any): string {
    const s = `${string}`;
    let r = "";
    for (let k = 0; k < s.length; k++) {
      if (s[k] === "%") {
        const wide = s[k + 1] === "u" ? hexAt(s, k + 2, 4) : -1;
        if (wide >= 0) { r += String.fromCharCode(wide); k += 5; continue; }
        const narrow = hexAt(s, k + 1, 2);
        if (narrow >= 0) { r += String.fromCharCode(narrow); k += 2; continue; }
      }
      r += s[k];
    }
    return r;
  },
};
export const escape = fns.escape;
export const unescape = fns.unescape;
