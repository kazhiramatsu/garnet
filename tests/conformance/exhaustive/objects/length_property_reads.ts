// `.length` reads: only a string's or an array's length is its builtin number;
// on any other receiver `length` is an ordinary property (an object field such
// as the compiler's TextSpan, ArrayLike values, getters, inherited values,
// functions, typed arrays), and a null or undefined receiver throws.
interface Bag { tag?: string; length?: number; }
interface Span { start: number; length: number; }
class Vec { constructor(public length: number) {} }
class Lazy { get length(): number { return 42; } }
function spanEnd(s: Span): number { return s.start + s.length; }
function lenOf(b: Bag): number | undefined { return b.length; }
function anyLen(x: any): unknown { return x.length; }
function generic<T extends string | readonly unknown[]>(x: T): number { return x.length; }
function shaped<T extends { length: number }>(x: T): number { return x.length; }
function either(x: string | string[] | Span): number { return x.length; }
function maybe(a: number[] | undefined, s: Span | undefined): string { return `${a?.length}/${s?.length}`; }
function tag(strings: TemplateStringsArray, ...values: unknown[]): string { return strings.length + ":" + values.length; }
// read-only uses of a parsed document keep it in place (the DOM path)
function domLengths(text: string): string {
  const d: any = JSON.parse(text);
  let total = 0;
  for (let i = 0; i < d.arr.length; i++) total += d.arr[i];
  return d.arr.length + "," + d.str.length + "," + d.obj.length + "," + d.num.length + "," + total;
}
function domNullLength(text: string): number {
  const d: any = JSON.parse(text);
  return d.nil.length;
}
function domMissingLength(text: string): number {
  const d: any = JSON.parse(text);
  return d.none.length;
}
function show(label: string, f: () => unknown): void {
  try { console.log(label, String(f())); } catch (e) { console.log(label, "throws", (e as Error).constructor.name); }
}
function main(): void {
  const proto: Bag = { length: 7 };
  const inherits = Object.create(proto) as Bag;
  show("optional absent", () => lenOf({ tag: "x" }));
  show("optional own", () => lenOf({ length: 5 }));
  show("inherited", () => lenOf(inherits));
  show("getter", () => lenOf(Object.defineProperty({}, "length", { get: () => 9 }) as Bag));
  show("span", () => spanEnd({ start: 10, length: 4 }));
  const arrayLike: ArrayLike<string> = { length: 2, 0: "a", 1: "b" };
  show("arraylike", () => arrayLike.length + "/" + Array.from(arrayLike).join(""));
  show("class field", () => new Vec(3).length);
  show("class getter", () => new Lazy().length);
  show("any string", () => anyLen("abcd"));
  show("any array", () => anyLen([1, 2, 3]));
  show("any object", () => anyLen({ length: 11 }));
  show("any plain", () => anyLen({}));
  show("any function", () => anyLen((a: number, b: number) => a + b));
  show("any number", () => anyLen(5));
  show("any null", () => anyLen(null));
  show("any undefined", () => anyLen(undefined));
  show("generic string", () => generic("xyz"));
  show("generic tuple", () => generic([1, "a"] as const));
  show("shaped object", () => shaped({ length: 6, other: 1 }));
  show("shaped array", () => shaped([1, 2]));
  show("union string", () => either("abc"));
  show("union array", () => either(["p", "q"]));
  show("union span", () => either({ start: 1, length: 8 }));
  show("optional chains", () => maybe([1, 2, 3], { start: 0, length: 2 }) + " " + maybe(undefined, undefined));
  show("template", () => tag`a${1}b${2}c`);
  show("regexp match", () => ("a1b2".match(/\d/g) as RegExpMatchArray).length);
  show("readonly", () => (["a", "b"] as Readonly<string[]>).length);
  show("function", () => ((a: number) => a).length);
  show("class value", () => Vec.length);
  // values of a parsed JSON document (read in place, docs: the JSON DOM)
  const doc: any = JSON.parse('{"arr":[1,2,3],"str":"h\\u00e9llo \\ud83d\\ude00","obj":{"length":12},"num":5,"nil":null}');
  show("json array", () => doc.arr.length);
  show("json string", () => doc.str.length);
  show("json object", () => doc.obj.length);
  show("json number", () => doc.num.length);
  show("json null", () => doc.nil.length);
  show("json missing", () => doc.none.length);
  const text = '{"arr":[4,5,6,7],"str":"\\u00e9t\\u00e9","obj":{"length":3},"num":1,"nil":null}';
  show("dom lengths", () => domLengths(text));
  show("dom null", () => domNullLength(text));
  show("dom missing", () => domMissingLength(text));
  let jsum = 0;
  for (let i = 0; i < doc.arr.length; i++) jsum += doc.arr[i];
  show("json loop", () => jsum);
  const counted: { length: number }[] = [];
  for (let i = 0; i < 2000; i++) counted.push({ length: i % 7 });
  let total = 0;
  for (const c of counted) total += c.length;
  show("loop", () => total);
}
main();
