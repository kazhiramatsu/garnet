// A value typed as a string or an array that is undefined at run time, with no cast: a read past an
// array's end, a `get()!` that missed. A member read or a method call on it is the TypeError V8 throws:
// not a fault, not a string "undefined", not a length of 0.
function attempt(f: () => unknown): string {
  try {
    return String(f());
  } catch (e) {
    return (e as Error).constructor.name;
  }
}
const noStrings: string[] = [];
const oneString = ["a"];
const noRows: number[][] = [];
const noObjects: { a: number; s: string }[] = [];
const empty = new Map<string, string>();
const record: Record<string, string> = {};
function lengthOf(xs: string[], i: number): number {
  return xs[i].length;
}
console.log(attempt(() => noStrings[0].length), attempt(() => lengthOf(oneString, 3)), attempt(() => lengthOf(oneString, 0)));
console.log(attempt(() => empty.get("k")!.toUpperCase()), attempt(() => empty.get("k")!.length), attempt(() => record["k"].length));
console.log(attempt(() => noStrings[5].charCodeAt(0)), attempt(() => noStrings[5].codePointAt(0)), attempt(() => noStrings[5][0]));
console.log(attempt(() => noStrings[5].slice(1)), attempt(() => noStrings[5].trim()), attempt(() => noStrings[5].split(",")));
console.log(attempt(() => noStrings[5].indexOf("a")), attempt(() => noStrings[5].startsWith("a")), attempt(() => noStrings[5].replace("a", "b")));
console.log(attempt(() => noStrings[5].concat("a")), attempt(() => noStrings[5].padStart(3)));
console.log(attempt(() => noRows[5].length), attempt(() => noRows[5][0]), attempt(() => noRows[5].push(1)), attempt(() => noRows[5].map((x) => x)));
console.log(attempt(() => noObjects[5].a), attempt(() => noObjects[5].s.length));
const nullString = null as unknown as string;
console.log(attempt(() => nullString.length), attempt(() => nullString.toLowerCase()));
// a String wrapper and every string method's ordinary receivers stay as they are
const wrapped: String = new String("Abc");
console.log(wrapped.toUpperCase(), wrapped.length, "x".concat("y"), `${"tmpl"}`.toUpperCase());
