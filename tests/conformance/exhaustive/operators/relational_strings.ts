// `<` `<=` `>` `>=` on values whose types the compiler does not narrow to
// number: number pairs in line, strings by code units (one-byte strings with
// memcmp, two-byte or mixed ones unit by unit), the rest through ToPrimitive.

function cmp(a: unknown, b: unknown): string {
  const x = a as string, y = b as string;
  return (x < y ? "<" : "") + (x <= y ? "le" : "") + (x > y ? ">" : "") + (x >= y ? "ge" : "");
}

function main(): void {
  const strs: string[] = [
    "", "a", "b", "ab", "abc", "abd", "abcé", "abcÿ", "abcĀ", "あ", "あい",
    "ab".repeat(20), "ab".repeat(20) + "c", "x" + String.fromCharCode(0), "x", "Z", "z", "😀", "￿",
  ];
  const out: string[] = [];
  for (const a of strs) {
    let row = "";
    for (const b of strs) row += cmp(a, b).length;
    out.push(row);
  }
  // slices (views) and concatenations compare like their flat forms
  const base = "prefix-" + "abcdefghij".repeat(3);
  const views = [base.slice(7, 17), base.slice(17, 27), base.substring(5), base.slice(0, 7), "prefix-a"];
  for (const v of views) out.push(views.map((w) => cmp(v, w)).join(","));
  // numbers, NaN, mixed, objects
  const vals: unknown[] = [1, 2, -0, 0, NaN, Infinity, "10", "9", "a", true, null, undefined, { valueOf: () => 3 }, [5]];
  for (const a of vals) out.push(vals.map((b) => cmp(a, b)).join(","));
  // a sort through the comparison
  const words = ["delta", "alpha", "éclair", "Bravo", "charlie", "alpha2", "あ", "", "a"];
  words.sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
  out.push(words.join("|"));
  let h = 0;
  for (const line of out) for (let i = 0; i < line.length; i++) h = (h * 33 + line.charCodeAt(i)) | 0;
  console.log(out.length, h, out[0], out[out.length - 1]);
}
main();
