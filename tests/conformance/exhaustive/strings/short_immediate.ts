function shortFrom(source: string, len: number): string {
  return source.slice(0, len);
}

const empty = shortFrom("abcdef", 0);
const one = shortFrom("abcdef", 1);
const two = shortFrom("abcdef", 2);
const three = shortFrom("abcdef", 3);
const four = shortFrom("abcdef", 4);
const five = shortFrom("abcdef", 5);
const six = shortFrom("abcdef", 6);

console.log(
  empty.length,
  one,
  two,
  three,
  four,
  five,
  six,
  typeof five
);
console.log(
  five === "abcde",
  five.indexOf("cd"),
  five.startsWith("ab"),
  five.endsWith("de"),
  five.charAt(2),
  five.charCodeAt(4)
);
console.log(five.toUpperCase(), five.slice(1, 4), five.substring(4, 1));
console.log("a".repeat(5), ["a", "b", "c"].join("-"));

const map = new Map<string, number>();
map.set(five, 51);
const set = new Set<string>();
set.add(three);
console.log(map.get("abcde"), map.has(shortFrom("abcde!", 5)), set.has("abc"));

const obj: any = {};
obj[three] = 7;
console.log(obj.abc, Object.keys(three).join(","), (three as any)[1]);

console.log(JSON.parse(shortFrom("123xxx", 3)), JSON.stringify(three));
console.log(/bc/.test(three), three.match("b")![0]);

const sym = Symbol(three);
console.log(sym.description, sym.toString());
