// new Array(v) and Array(v) with one argument: a number is the length (a RangeError when it is not an
// array length), any other value the array's one element. Which it is, is the argument's value: through
// `any`, `unknown`, a union and a type parameter it is known at run time only (taken for an element,
// `new Array(n)` with `n: any = 3` was `[3]`).
function show(label: string, make: () => unknown[]): void {
  try {
    const a = make();
    console.log(label, a.length, JSON.stringify(a), 0 in a);
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message);
  }
}
function of<T>(v: T): unknown[] {
  return new Array(v);
}
function called<T>(v: T): unknown[] {
  return Array(v);
}
function main(): void {
  const three: any = 3, negative: any = -1, fraction: any = 1.5, huge: any = 2 ** 32, zero: any = 0;
  const text: any = "3", flag: any = true, none: any = undefined, nothing: any = null, list: any = [5], obj: any = { n: 1 };
  show("any 3", () => new Array(three));
  show("any -1", () => new Array(negative));
  show("any 1.5", () => new Array(fraction));
  show("any 2**32", () => new Array(huge));
  show("any 0", () => new Array(zero));
  show("any '3'", () => new Array(text));
  show("any true", () => new Array(flag));
  show("any undefined", () => new Array(none));
  show("any null", () => new Array(nothing));
  show("any [5]", () => new Array(list));
  show("any {}", () => new Array(obj));
  show("call any 3", () => Array(three));
  show("call any -1", () => Array(negative));
  show("call any '3'", () => Array(text));
  const u: unknown = 4;
  show("unknown 4", () => new Array(u));
  const either: number | string = Math.random() < 2 ? 2 : "two";
  show("union number", () => new Array(either));
  const other: number | string = Math.random() < 2 ? "two" : 2;
  show("union string", () => new Array(other));
  show("generic 2", () => of(2));
  show("generic 'a'", () => of("a"));
  show("generic -2", () => of(-2));
  show("generic call 2", () => called(2));
  show("generic call {}", () => called({ k: 1 }));
  // the argument's type says what it is
  const n = 2;
  show("number", () => new Array(n));
  show("number -1", () => new Array(-1));
  show("string", () => new Array("x"));
  show("object", () => new Array({ a: 1 }));
  show("two", () => new Array(three, three));
  show("none", () => new Array());
  // the array is one: holes, a length, elements stored later
  const made = new Array(three);
  made[1] = "m";
  console.log(made.length, made.join("-"), made.indexOf(undefined), Object.keys(made).join(","));
}
main();
