// A regexp result array with more than four captures lives in one cell (ts_new_array_compact):
// the array operations over it (growth by push and index stores, shift and unshift, splice, sort,
// reverse, fill, length changes, sparse stores far out, deletion, spread, JSON) behave as on any
// array, with its named properties kept, and the typed `indexOf` with an immediate needle.
function show(label: string, v: unknown): void { console.log(label, JSON.stringify(v)); }
function main(): void {
  const re = /(a)(b)?(c)(d)?(e)(f)?(g)(h)?(i)(j)?/;
  const m = "xacegi".match(re);
  if (!m) throw new Error("no match");
  show("m", m); show("len", m.length); show("index", m.index); show("keys", Object.keys(m));
  show("indexOf c", m.indexOf("c")); show("indexOf ''", m.indexOf("")); show("indexOf from", m.indexOf("g", 3)); show("lastIndexOf", m.lastIndexOf("i"));
  show("includes", [m.includes("e"), m.includes("z")]);
  m.push("k"); m.push("l"); show("pushed", [m.length, m[11], m[12], m.index]);
  show("shift", [m.shift(), m.length, m[0]]); m.unshift("A", "B"); show("unshift", [m.length, m[0], m[1], m[2]]);
  show("splice", [m.splice(2, 3, "X"), m.length, m.slice(0, 5)]);
  m[20] = "far"; show("far", [m.length, m[19], m[20], 19 in m]);
  m.length = 6; show("truncate", [m.length, m[5], m[6]]);
  m.length = 9; show("grow", [m.length, m[8]]);
  delete m[1]; show("delete", [m.length, m[1], 1 in m, Object.keys(m)]);
  m.fill("z", 1, 3); show("fill", m.slice(0, 4));
  show("sort", [...m].sort()); show("reverse", m.slice().reverse()); show("concat", m.concat(["q"]).length);
  show("json", JSON.stringify(m)); show("named kept", [m.index, m.input, m.groups]);
  // the compact cell of a result with many captures, and one at the inline limit
  const big = /(1)(2)(3)(4)(5)(6)(7)(8)(9)(0)(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)(m)(n)(o)(p)(q)(r)(s)(t)(u)(v)(w)(x)(y)(z)/;
  const bm = "1234567890abcdefghijklmnopqrstuvwxyz".match(big);
  show("big", bm ? [bm.length, bm[36], bm.indexOf("k"), bm.index] : null);
  const four = /(a)(b)(c)/.exec("abc");
  show("four", four ? [four.length, four.indexOf("c"), four[3]] : null);
  const five = /(a)(b)(c)(d)/.exec("abcd");
  show("five", five ? [five.length, five.indexOf("d"), five[4], Object.keys(five)] : null);
  // a result array held across many allocations and collections
  const held: RegExpMatchArray[] = [];
  for (let i = 0; i < 2000; i++){ const r = ("q" + i + "r").match(/(q)(\d)(\d)?(\d)?(\d)?(r)/); if (r) held.push(r); }
  let sum = 0; for (const r of held) sum += r.length + (r.index ?? 0) + r.indexOf("r");
  show("held", [held.length, sum, held[1999][0], held[0].input]);
  // global-match arrays (no named properties) and split results are plain arrays
  const g = "a1b22c333".match(/\d+/g); if (g){ g.push("x"); show("g", [g.length, g.indexOf("333"), Object.keys(g)]); }
}
main();
