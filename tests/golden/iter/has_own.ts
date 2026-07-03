class Base { bx = 1; }
class Derived extends Base { dy = 2; }
function main(): void {
  const d: any = new Derived();
  console.log("bx" in d, "dy" in d, "zz" in d);
  console.log(d.hasOwnProperty("bx"), d.hasOwnProperty("zz"));
  console.log(Object.hasOwn(d, "dy"), Object.hasOwn(d, "qq"));
  const o: any = { a: 1 };
  Object.defineProperty(o, "acc", { get: () => 5 });
  console.log(o.hasOwnProperty("a"), o.hasOwnProperty("acc"), "acc" in o);
  const k = "a";
  console.log(o.hasOwnProperty(k), Object.hasOwn(o, k), k in o);
}

main();
