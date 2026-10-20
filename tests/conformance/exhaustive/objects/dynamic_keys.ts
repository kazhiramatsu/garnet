// Dynamic property keys (docs/dynamic_keys_design.md): numbers become their
// canonical decimal strings (small integers through a table, -0 as "0"),
// string literals and computed strings intern to the same key, non-ASCII,
// surrogate pairs, lone surrogates and long strings keep their identity.
function main(): void {
  const o: any = {};
  const nums = [0, 1, -0, -5, 7, 4095, 4096, 65536, 1e21, 1.5, NaN, Infinity, -Infinity, 2 ** 53, 0.1 + 0.2];
  for (const n of nums) o[n] = "n" + String(n);
  console.log(Object.keys(o).join(" | "));
  console.log(o["0"], o[0], o[-0], o["-5"], o[4095], o["4096"], o["1e+21"], o[1.5], o["NaN"], o[Infinity], o["9007199254740992"]);
  const tbl: Record<number, string> = { [1]: "one", [166]: "kind166", [3000]: "k3000" };
  let hits = "";
  for (let r = 0; r < 3; r++) for (const k of [1, 166, 3000, 5]) hits += (tbl[k] ?? "-") + ",";
  console.log(hits);

  // literal and computed strings share keys
  const s: any = { pos: 1, end: 2 };
  const name = ["p", "o", "s"].join("");
  console.log(s.hasOwnProperty("pos"), s.hasOwnProperty(name), s.hasOwnProperty("end"), s.hasOwnProperty("len"), "pos" in s, name in s);
  s[name + "2"] = 3; s["pos2"] += 10;
  console.log(s.pos2, Object.keys(s).join(","));

  // non-ASCII, surrogate pairs, a lone surrogate, a long key
  const u: any = {};
  const keys = ["é", "日本", "\u{1F600}", "a\uD800b", "x".repeat(80), "y".repeat(64), "é".repeat(70)];
  keys.forEach((k, i) => { u[k] = i; });
  console.log(keys.map((k) => u[k]).join(","), Object.keys(u).map((k) => k.length).join(","));
  const built = "日" + "本";
  console.log(u[built], u["😀"], built in u, delete u[built], built in u);

  // symbols and the dynamic writes on one site
  const sym = Symbol("t");
  const w: any = { [sym]: "sym" };
  console.log(w[sym], Object.keys(w).length);
  const counts: any = {};
  for (let i = 0; i < 5000; i++) { const k = i % 50; counts[k] = (counts[k] ?? 0) + 1; }
  console.log(Object.keys(counts).length, counts[0], counts[49], counts["25"]);
}
main();
