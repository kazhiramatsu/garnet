// @ts-nocheck
// JSON's strings and containers, by the grammar. A pair of `\u` escapes is one code point (it was two U+FFFD: Python's
// json.dumps writes every character past the BMP so); a lone surrogate stays one; a `\u` takes four hex digits and an
// unknown escape is a SyntaxError (`"\x41"` was "x41"); `[`, `[1,`, `{` and `{"a":1,` were values (silent). A Number, String
// or Boolean object at the root reaches toJSON and the replacer as the object.
const t = (s) => { try { const v = JSON.parse(s); console.log(JSON.stringify(s), "->", typeof v === "string" ? [v, v.length, [...v].length, v.codePointAt(0)] : v); } catch (e) { console.log(JSON.stringify(s), e.name); } };
for (const s of ['"\\uD83D\\uDE00"', '"\\ud83d\\ude00x"', '"a\\uD83D"', '"\\uDE00"', '"\\uD83Dx"', '"\\uD83D\\u0041"', '"\\uD83D\\uD83D\\uDE00"', '"\\u00e9\\u4e2d"', '"\\u12g4"', '"\\u12"', '"\\x41"', '"\\\'"', '"\\a"', '"\\/"', '"tab\\there"',
  "[", "[1,", "[1", "{", '{"a":1,', '{"a":1', '{"a"', '{"a":', "[[[]]", '{"a":[}', "", " ", "[]", "{}", "[ 1 , 2 ]", '{ "a" : 1 }']) t(s);
console.log(JSON.parse('{"k\\uD83D\\uDE00":1}'), Object.keys(JSON.parse('{"\\uD83D":1}'))[0].length, JSON.stringify(JSON.parse('"\\ud83d"')), JSON.parse(JSON.stringify("\ud83d")) === "\ud83d");
console.log(JSON.parse('["\\uD83D\\uDE00", {"x": "\\u00e9\\uD83D"}]'), JSON.parse(JSON.stringify({ s: "a\ud800b\udfffc" })));
const r = (k, x) => (typeof x === "number" ? x + 1 : typeof x === "object" && x !== null && !Array.isArray(x) ? "obj:" + typeof x.valueOf() : x);
for (const v of [new Number(3), new String("s"), new Boolean(false), 3, { a: new Number(1), b: new String("t") }, [new Number(2)], Object(1n)]) {
  let out; try { out = [JSON.stringify(v), JSON.stringify(v, r), JSON.stringify(v, (k, x) => x)]; } catch (e) { out = e.name; } console.log(out);
}
const n: any = new Number(5); n.toJSON = () => "own"; console.log(JSON.stringify(n), JSON.stringify({ n }), JSON.stringify([n]));
