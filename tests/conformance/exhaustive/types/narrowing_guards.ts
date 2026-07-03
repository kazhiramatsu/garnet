function isString(x: unknown): x is string { return typeof x === "string"; }
interface Bird { fly(): string; }
interface Fish { swim(): string; }
function isFish(p: Bird | Fish): p is Fish { return (p as Fish).swim !== undefined; }

function describe(x: string | number | null): string {
  if (x === null) return "null";
  if (typeof x === "number") return "num:" + x;
  return "str:" + x.toUpperCase();
}

function main(): void {
  console.log(describe("hi"), describe(5), describe(null)); // str:HI num:5 null
  const vals: unknown[] = ["a", 1, "b", true];
  console.log(vals.filter(isString).join(","));             // a,b
  const pet: Bird | Fish = { swim: () => "splash" };
  console.log(isFish(pet) ? pet.swim() : "fly");            // splash
  const u: unknown = 42;
  if (typeof u === "number") console.log(u * 2);            // 84
}
main();
