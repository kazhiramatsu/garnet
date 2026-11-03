// @ts-nocheck
const t = (name, f) => { try { console.log(name, f()); } catch (e) { console.log(name, "THROW", e.name, e.message); } };
console.log(typeof Symbol.match, Symbol.match.toString(), Symbol.replace.description, Symbol.species.toString(), String(Symbol.isConcatSpreadable), String(Symbol.unscopables));
t("desc", () => JSON.stringify(Object.getOwnPropertyDescriptor(Symbol, "match")) + typeof Object.getOwnPropertyDescriptor(Symbol, "match").value);
// custom matchers
const m0 = { [Symbol.matchAll](s) { return "MA:" + s; } }; t("custom matchAll", () => "hello".matchAll(m0));
const m = { [Symbol.match](s) { return "M:" + s; }, [Symbol.replace](s, r) { return "R:" + s + ":" + r; }, [Symbol.search](s) { return "S:" + s; }, [Symbol.split](s, l) { return "SP:" + s + ":" + l; } };
const s = "hello";
t("custom", () => [s.match(m), s.replace(m, "x"), s.search(m), s.split(m, 2)]);
t("flags nullish", () => s.replaceAll(m, "y"));
t("custom replaceAll", () => s.replaceAll({ flags: "g", [Symbol.match]: true, [Symbol.replace](s, r) { return [s, r]; } }, "y"));
class Matcher { [Symbol.replace](s, r) { return s + r; } }
t("class", () => s.replace(new Matcher(), "!"));
t("this passthrough", () => String.prototype.replace.call(1234, { [Symbol.replace](o, r) { return [typeof o, o, r]; } }, "z"));
// the builtins through the symbol
t("rx match", () => [/l+/[Symbol.match]("hello"), /l/g[Symbol.match]("hello")]);
t("rx replace", () => [/l/g[Symbol.replace]("hello", "L"), /(l)(l)/[Symbol.replace]("hello", "$2-$1"), /(?<a>l)/[Symbol.replace]("hello", "[$<a>]")]);
t("rx search", () => [/l/[Symbol.search]("hello"), /z/[Symbol.search]("hello")]);
t("rx split", () => [/l/[Symbol.split]("hello"), /l/[Symbol.split]("hello", 1), /(l)/[Symbol.split]("hello")]);
t("rx matchAll", () => [...(/l/g[Symbol.matchAll]("hello"))].map((m) => m.index));
t("names", () => [RegExp.prototype[Symbol.match].name, RegExp.prototype[Symbol.replace].length, RegExp.prototype[Symbol.split].length, RegExp.prototype[Symbol.matchAll].name, RegExp.prototype[Symbol.search].length]);
// exec overridden
const re = /a/g; let calls = 0; const realExec = re.exec;
re.exec = function (x) { calls++; return RegExp.prototype.exec.call(this, x); };
t("own exec", () => ["aXa".replace(re, "b"), calls, re.test("a"), calls]);
class R extends RegExp { exec(x) { const r = super.exec(x); if (r) r[0] = r[0].toUpperCase(); return r; } }
t("subclass exec", () => ["abc".replace(new R("b"), "[$&]"), "abc".match(new R("b"))[0], new R("b").test("b"), "abc".split(new R("b"))]);
t("generic", () => RegExp.prototype[Symbol.replace].call({ flags: "", exec() { return null; } }, "abc", "x"));
t("generic exec result", () => RegExp.prototype[Symbol.replace].call({ flags: "", exec() { return { 0: "b", index: 1, length: 1 }; } }, "abc", "x"));
t("generic bad exec", () => RegExp.prototype[Symbol.replace].call({ flags: "", exec() { return 5; } }, "abc", "x"));
t("non-object", () => RegExp.prototype[Symbol.match].call(1, "x"));
t("flags generic", () => Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get.call({ global: 1, sticky: 1, hasIndices: true }));
t("flags num", () => Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get.call(1));
t("IsRegExp ctor", () => { const o = { [Symbol.match]: true, source: "a+", flags: "g" }; const r = new RegExp(o); return [r.source, r.flags]; });
t("IsRegExp call", () => { const r = /a/; return [RegExp(r) === r, new RegExp(r) === r]; });
t("startsWith", () => { const o = /a/; o[Symbol.match] = false; return "/a/".startsWith(o); });
t("startsWith2", () => "abc".startsWith({ [Symbol.match]: true }));
t("replaceAll nog", () => "a".replaceAll(/a/, "b"));
t("matchAll nog", () => "a".matchAll(/a/));
t("matchAll tag", () => { const it = "aa".matchAll(/a/g); return [Object.prototype.toString.call(it), typeof it.next, [...it].length, it[Symbol.iterator]() === it]; });
t("matchAll string", () => [..."a.b".matchAll(".")].map((m) => m.index));
t("match string", () => [..."a.b".match(".")]);
t("search string", () => "a.b".search("."));
t("patched proto", () => { const o = RegExp.prototype[Symbol.search]; RegExp.prototype[Symbol.search] = () => 42; const r = "abc".search(/b/); RegExp.prototype[Symbol.search] = o; return r; });
const dyn = "x.y"; const pat = ".";
t("typed nonconst", () => [dyn.match(pat)?.[0], dyn.search(pat), [...dyn.matchAll(pat)].length]);
