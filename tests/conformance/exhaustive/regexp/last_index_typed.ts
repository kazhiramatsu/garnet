// The typed `lastIndex` access (docs/regexp_vm_design.md "The per-call path"): reads, writes,
// compound and update forms on a receiver typed RegExp, the same sites on values that are not a
// RegExp with a plain lastIndex (a plain object, null, a read-only lastIndex), the result array's
// shape (its named properties, holes, JSON, indices), `s + ""`, and the search loop's quick check
// on alternations, case-insensitive patterns, classes under a quantifier and impossible patterns.
function main(): void {
  const re = /a(b)?/g;
  re.lastIndex = 2;
  console.log(re.lastIndex, re.test("xxab"), re.lastIndex);
  re.lastIndex += 10; console.log(re.lastIndex, re.test("ab"), re.lastIndex);
  re.lastIndex++; console.log(re.lastIndex);
  const o: RegExp = { lastIndex: 7 } as any; console.log(o.lastIndex); o.lastIndex = 9; console.log(o.lastIndex, (o as any).lastIndex);
  const n: RegExp = null as any; try { console.log(n.lastIndex); } catch (e) { console.log((e as Error).message); }
  try { n.lastIndex = 1; } catch (e) { console.log((e as Error).message); }
  const acc = /q/g; acc.lastIndex = 4; Object.defineProperty(acc, "lastIndex", { writable: false });
  console.log(acc.lastIndex); try { acc.lastIndex = 5; } catch (e) { console.log((e as Error).constructor.name, acc.lastIndex); }
  try { acc.lastIndex += 1; } catch (e) { console.log((e as Error).constructor.name, acc.lastIndex); }
  try { console.log(acc.test("q"), acc.lastIndex); } catch (e) { console.log((e as Error).constructor.name, acc.lastIndex); }
  const ng = /q/; Object.defineProperty(ng, "lastIndex", { writable: false }); console.log(ng.test("q"), ng.lastIndex);
  const fro = /z/g; Object.freeze(fro); try { fro.lastIndex = 3; } catch (e) { console.log((e as Error).constructor.name); } console.log(fro.lastIndex);
  const m = new RegExp("(\\d)(x)?(?<n>y)?", "d").exec("1y")! as any;
  console.log(m.length, m[0], m[1], m[2], 2 in m, m.index, m.input, Object.keys(m).join(","), JSON.stringify(m), m.groups.n, JSON.stringify(m.indices), m.indices.groups.n[0]);
  console.log(Object.getOwnPropertyNames(m).join(","));
  const s = "abc"; const t = s + ""; const u = "" + s; console.log(t === s, u, ("" + 5), (5 + ""), typeof ("" + 5));
  const texts = ["the quick brown fox", "an ERROR occurred", "warning: low", "fatal", "fatality", "err", "xwarning", "", "e", "er", "err", "erro", "error"];
  for (const x of texts) console.log(x, /error|warning|fatal/i.test(x), x.search(/error|warning|fatal/i), /[aeiou]{2,}/.exec(x)?.[0], /ab|cd/.test(x), /(?:ab|c)d/.test(x));
  console.log(/é/.test("café"), /\u{1F600}/u.test("x"), /[^\x00-\xff]/.test("abc"), /K/i.test("k"), /Ā/i.test("a"), /xyz|xy/.test("xy"), /(?=ab)a/.test("ab"));
  console.log("aXbXc".split(/x/i).join("|"), "foo bar".replace(/o+|a/g, "_"), "abcabc".match(/bc|ca/g)!.join(","));
}
main();
