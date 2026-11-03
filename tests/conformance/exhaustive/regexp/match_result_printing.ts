// A program that names no protocol: the direct paths, the typed string pattern forms.
const dyn: string = "x.y"; const pat: string = ".";
console.log(dyn.match(pat)?.[0], dyn.search(pat), [...dyn.matchAll(pat as any)].length, "a.b".replace(pat, "-"), dyn.split(pat));
console.log("aXa".replace(/a/g, "b"), /a/.test("a"), "abc".match(/b/)?.index);
console.log(/l+/.exec("hello"));
console.log([/l+/.exec("hello")]);
console.log({ a: /l+/.exec("hello") });
console.log("hello".match(/l+/));
const arr: any = [1, 2]; arr.x = 3; console.log(arr, [arr], { arr });
console.log(JSON.stringify({ a: Symbol("x"), b: 1 }), JSON.stringify([Symbol("y")]), JSON.stringify(Symbol("z")));
