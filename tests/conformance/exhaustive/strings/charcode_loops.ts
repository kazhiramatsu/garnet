// charCodeAt in loops over a string the loop never assigns: a one-byte text,
// a two-byte text, an immediate (short) string, a sliced view, an empty
// string, indices out of range, fractional and NaN indices, a receiver
// reassigned inside the loop, and a receiver that is not a string at run time.
function sumCodes(text: string, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s = (s + text.charCodeAt(i)) | 0;
  return s;
}
function countNewlines(text: string): number {
  let n = 0;
  let pos = 0;
  while (pos < text.length) {
    const ch = text.charCodeAt(pos);
    if (ch === 10) n++;
    else if (ch === 13) { n++; if (text.charCodeAt(pos + 1) === 10) pos++; }
    pos++;
  }
  return n;
}
function oddIndices(text: string): string {
  const out: number[] = [];
  for (let i = 0.5; i < text.length + 2; i += 1) out.push(text.charCodeAt(i));
  out.push(text.charCodeAt(NaN), text.charCodeAt(-1), text.charCodeAt(text.length), text.charCodeAt(Infinity));
  return out.join(",");
}
function reassigned(a: string, b: string): number {
  let t = a;
  let s = 0;
  for (let i = 0; i < 6; i++) {
    s += isNaN(t.charCodeAt(i)) ? 1000 : t.charCodeAt(i);
    t = i % 2 === 0 ? b : a;
  }
  return s;
}
function anyRecv(x: unknown): string {
  const t = x as string;
  const out: unknown[] = [];
  try {
    for (let i = 0; i < 3; i++) out.push(t.charCodeAt(i));
  } catch (e) {
    out.push((e as Error).constructor.name);
  }
  return out.join("|");
}
function main() {
  let one = "";
  for (let i = 0; i < 40; i++) one += "line " + i + "\r\n";
  const two = "αβγ\n" + one + "ω\r\n";
  const out: unknown[] = [sumCodes(one, 0, one.length), sumCodes(two, 0, two.length), sumCodes(one, 10, 20), sumCodes(two, 0, 5), sumCodes("abc", 0, 3), sumCodes("ab", 0, 5)];
  out.push(countNewlines(one), countNewlines(two), countNewlines(""), countNewlines("a\rb\nc\r\nd"));
  out.push(oddIndices("hey"), oddIndices("héllo"), oddIndices("ω"), oddIndices(""));
  const view = two.slice(4, 30);
  out.push(sumCodes(view, 0, view.length), countNewlines(view), oddIndices(view.slice(0, 3)));
  out.push(reassigned("abc", "xyzw"), reassigned("", "q"));
  out.push(anyRecv("str"), anyRecv(12345), anyRecv(undefined), anyRecv(null), anyRecv({ charCodeAt: (i: number) => i * 7 }));
  console.log(JSON.stringify(out));
}
main();
