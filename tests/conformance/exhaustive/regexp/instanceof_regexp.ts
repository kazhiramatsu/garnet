// `x instanceof RegExp`: a literal, a constructed regexp, a value of a union type, and non-regexps (a string,
// an object with a test method, an array); the result as a branch condition and as a value.
function kind(v: unknown): string {
  if (v instanceof RegExp) return "regexp:" + v.source;
  return typeof v === "string" ? "string" : Array.isArray(v) ? "array" : typeof v;
}
function main(): void {
  const out: string[] = [];
  const fnOrRegex: ((s: string) => boolean) | RegExp = /^a+$/;
  out.push(String(fnOrRegex instanceof RegExp), kind(/x\d+/g), kind(new RegExp("y", "i")), kind("re"), kind({ test: () => true }), kind([/a/]));
  const re: RegExp | string = Math.random() < 2 ? new RegExp("z") : "zz";
  out.push(re instanceof RegExp ? "re " + (re as RegExp).test("z") : "str");
  out.push(String(!(5 instanceof RegExp)), String(((v: unknown) => v instanceof RegExp)(/q/)));
  console.log(out.join("\n"));
}
main();
