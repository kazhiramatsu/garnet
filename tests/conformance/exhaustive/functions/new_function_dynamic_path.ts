// `new Function(src)` on a path the program never takes (a dev-only validator, an eval fallback): the
// program compiles, the site throws an EvalError if reached (V8 compiles the source; the fixture keeps
// to the static path so both agree).
function dynamicAdd(a: number, b: number): number {
  const f = new Function("a", "b", "return a + b") as (a: number, b: number) => number;
  return f(a, b);
}
function add(a: number, b: number, dynamic: boolean): number {
  if (dynamic) return dynamicAdd(a, b);
  return a + b;
}
function validate(exp: string, strictly: boolean): string {
  if (!strictly) return exp.trim().length > 0 ? "ok" : "empty";
  try {
    new Function(`return (${exp})`);
    return "ok";
  } catch (e) {
    return "error";
  }
}
function main(): void {
  console.log(add(2, 3, false), add(-1, 1, false));
  console.log(validate("a + b", false), validate("   ", false), typeof dynamicAdd, typeof validate);
}
main();
