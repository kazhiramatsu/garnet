// String accumulators (docs/string_accumulators_design.md): locals only
// appended to, read for their length and returned are built in a private
// buffer; every observable result must equal the generic `+`.
interface T { id: number; }
function typeListId(types: readonly T[] | undefined): string {
  let result = "";
  if (types) {
    const length = types.length;
    let i = 0;
    while (i < length) {
      const startId = types[i].id;
      let count = 1;
      while (i + count < length && types[i + count].id === startId + count) count++;
      if (result.length) result += ",";
      result += startId;
      if (count > 1) result += ":" + count;
      i += count;
    }
  }
  return result;
}
function mixed(): string {
  let s = "x";
  s += 1.5; s += -0; s += -7; s += 1e21; s += NaN; s += true; s += null; s += undefined;
  s += { toString() { return "[ts]"; } };
  s += { valueOf() { return 42; } };
  s += { [Symbol.toPrimitive](hint: string) { return "<" + hint + ">"; } };
  s += [1, 2]; s += "é"; s += "\u{1F600}"; s += "\uD800";
  return s;
}
function grow(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) { s += i % 10; if (s.length % 97 === 0) s += "|"; }
  return s;
}
function utf16Late(): string {
  let s = "ascii-start-";
  for (let i = 0; i < 40; i++) s += "a";
  s += "日本";
  for (let i = 0; i < 40; i++) s += "b";
  return s;
}
function throwing(xs: unknown[]): string {
  let s = "";
  try {
    for (const x of xs) s += (x as { v(): string }).v();
  } catch (e) {
    return s;
  }
  return s;
}
function shortOnes(k: number): string { let s = ""; if (k > 0) s += "ab"; if (k > 1) s += "c"; return s; }
function earlyReturn(xs: number[]): string {
  let s = "";
  for (const x of xs) { if (x < 0) return s; s += x; s += ";"; }
  return s;
}
function notAnAccumulator(xs: string[]): string {
  let s = "";
  const seen: string[] = [];
  for (const x of xs) { s += x; seen.push(s); }
  return seen.join("/") + "=" + s;
}
function main(): void {
  console.log(typeListId([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 7 }, { id: 9 }, { id: 10 }]), typeListId(undefined), typeListId([]));
  console.log(mixed());
  const g = grow(5000);
  console.log(g.length, g.slice(0, 30), g.slice(-20));
  const u = utf16Late();
  console.log(u.length, u.slice(50, 58), u.charCodeAt(52));
  console.log(throwing([{ v: () => "a" }, { v: () => "b" }, {}, { v: () => "c" }]));
  const m = new Map<string, number>();
  m.set(shortOnes(1), 1); m.set(shortOnes(2), 2); m.set(shortOnes(0), 0);
  console.log(shortOnes(1) === "ab", shortOnes(2) === "abc", shortOnes(0) === "", m.get("ab"), m.get("abc"), m.get(""));
  console.log(earlyReturn([1, 2, -1, 3]), earlyReturn([4]));
  console.log(notAnAccumulator(["p", "q", "r"]));
  let total = 0;
  for (let r = 0; r < 2000; r++) total += typeListId([{ id: r }, { id: r + 1 }, { id: r + 5 }]).length;
  console.log(total);
}
main();
