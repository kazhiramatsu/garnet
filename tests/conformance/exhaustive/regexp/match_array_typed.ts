// The RegExp result types as array receivers: lib's RegExpMatchArray / RegExpExecArray are the
// runtime's result arrays, so a method on one (`indexOf` over hono's empty-capture route markers),
// element access, `length`, for..of, spread and destructuring take the typed array paths; the
// named properties (`index`, `input`, `groups`, `indices`) keep their values and their order; a
// global match's array has no named properties; an added property follows the layout.
function show(label: string, v: unknown): void { console.log(label, JSON.stringify(v)); }
function first(a: string[]): string { return a[0]; }
function main(): void {
  const m = "a1b22c".match(/(\d)(x)?(b)?/);
  if (!m) throw new Error("no match");
  show("m", m); show("index", m.index); show("input", m.input); show("groups", m.groups);
  show("length", m.length); show("m0", m[0]); show("m1", m[1]); show("m2", m[2]); show("m3", m[3]); show("m9", m[9]);
  show("indexOf b", m.indexOf("b")); show("indexOf '' from 1", m.indexOf("", 1)); show("includes 1", m.includes("1"));
  show("lastIndexOf 1", m.lastIndexOf("1")); show("slice 1", m.slice(1)); show("join", m.join("|"));
  show("map", m.map((x) => typeof x)); show("filter", m.filter((x) => x !== undefined));
  show("spread", [...m]); show("last", m[m.length - 1]); show("find", m.find((x) => x === "b")); show("findIndex", m.findIndex((x) => x === undefined));
  show("some", m.some((x) => x === "1")); show("every", m.every((x) => typeof x === "string"));
  const parts: string[] = []; for (const x of m) parts.push(String(x)); show("for-of", parts);
  const [whole, d1] = m; show("destructure", [whole, d1]);
  show("first", first(m)); show("isArray", Array.isArray(m)); show("keys", Object.keys(m)); show("json", JSON.stringify(m));
  show("concat", m.concat(["z"]));
  m[1] = "Z"; m.push("q"); show("after writes", [m.length, m[1], m[4], m.indexOf("q")]);
  (m as any).extra = 1; show("keys after extra", Object.keys(m)); show("extra", (m as any).extra); show("index kept", m.index);
  // exec with named groups and match indices
  const e = new RegExp("(?<y>\\d{4})-(?<mo>\\d\\d)", "d").exec("on 2024-05!");
  if (!e) throw new Error("no exec");
  show("e", e); show("e.index", e.index); show("e.input", e.input); show("e.groups", e.groups); show("e.groups.y", e.groups!.y);
  const ind = (e as any).indices; show("e.indices0", ind[0]); show("e.indices.groups.mo", ind.groups.mo); show("keys e", Object.keys(e));
  show("e.indexOf 05", e.indexOf("05")); show("e.length", e.length);
  // a global match: an array of the matches, no named properties
  const g = "a1b2c33".match(/\d+/g);
  if (!g) throw new Error("no global match");
  show("g", g); show("g.index", g.index); show("g.input", g.input); show("g.indexOf 33", g.indexOf("33")); show("g keys", Object.keys(g));
  // matchAll's results
  for (const r of "x1y2".matchAll(/(?<d>\d)/g)) show("matchAll", [r[0], r.index, r.indexOf(r[0]), r.groups!.d, Object.keys(r)]);
  // hono's RegExpRouter: the first empty capture after the whole match names the matched route
  const re = /^\/(?:a(?:$()|\/b$())|c\/([^/]+)$())/;
  for (const path of ["/a", "/a/b", "/c/xyz", "/nowhere"]) {
    const mm = path.match(re);
    show(path, mm ? [mm.indexOf("", 1), mm.length, mm[3], mm.index] : null);
  }
  // the same through `any` (the dynamic paths) agrees
  const am: any = "q7".match(/\d/);
  show("any", [am.indexOf("7"), am.index, am.input, am.length, Object.keys(am)]);
  // a sticky exec's result and a failed match
  const st = /\d/y; st.lastIndex = 1; const se = st.exec("a7");
  show("sticky", se ? [se[0], se.index, se.indexOf("7")] : null); show("fail", /z/.exec("abc"));
}
main();
