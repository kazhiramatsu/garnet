// `string + integer`, `integer + string` and template literals with integer
// parts take an allocation-free formatting path; the results must be the exact
// strings V8 produces, in every length class and for every number kind.
function main(): void {
  const nums = [0, -0, 1, -1, 7, 42, 999, -1000, 123456789, 9007199254740991, 9007199254740992, -9007199254740991, 2 ** 53 + 2, 1e15, 9e15, 1e16, 1e21, 1.5, -0.25, NaN, Infinity, -Infinity, 1e-7, 0.1 + 0.2];
  const prefixes = ["", "a", "ab", "abcd", "abcde", "abcdef", "0123456789abcdefghij", "0123456789abcdefghijkl", "0123456789abcdefghijklmnop", "é", "日本語", "x".repeat(40)];
  const out: string[] = [];
  for (const p of prefixes) for (const n of nums) { out.push(p + n); out.push(n + p); out.push(`${p}${n}`); out.push(`${n}:${p}`); out.push(`${n},${n}${p ? ":" + p : ""}`); }
  console.log(out.length, out.join("|").length);
  let h = 0; for (const s of out) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; console.log(h);
  // views and builder-sized operands
  const long = "0123456789".repeat(5); const view = long.substring(3, 30);
  console.log(view + 12, 12 + view, (long + 7).length, (7 + long).length, `${view}${1}${2}${3}`);
  let acc = ""; for (let i = 0; i < 40; i++) acc += i; console.log(acc, acc.length);
  let acc2 = "k"; for (let i = 0; i < 30; i++) acc2 = acc2 + "," + i; console.log(acc2);
  // keys built this way are equal to literals and work as Map keys
  const m = new Map<string, number>(); m.set("12,34", 1); m.set("12,34:2", 2); m.set("abc5", 3);
  console.log(m.get(`${12},${34}`), m.get(`${12},${34}` + ":" + 2), m.get("abc" + 5), ("abc" + 5) === "abc5", (5 + "abc") === "5abc", `${1}${2}` === "12");
  // short immediates: equal by content, unequal otherwise; switch on short and long literals
  const names = ["this", "that", "window", "self", "me", "document", "xx"];
  let picks = "";
  for (const nm of names) { switch (nm) { case "this": picks += "T"; break; case "window": picks += "W"; break; case "self": picks += "S"; break; case "document": picks += "D"; break; default: picks += "-"; } picks += (nm === "th" + "is") ? "+" : "."; }
  console.log(picks);
  // GC pressure while keys are built from young strings
  const keys: string[] = [];
  for (let i = 0; i < 30000; i++) { const base = "t" + (i & 255); keys.push(base + i + ":" + (i & 7)); if ((i & 8191) === 0) { let junk = 0; for (let j = 0; j < 20000; j++) junk += [j].length; if (junk < 0) console.log(junk); } }
  let total = 0; for (const k of keys) total += k.length; console.log(total, keys[12345], keys[29999]);
}
main();
