// `in` operator: own/inherited property presence. For arrays it must see numeric
// indices in bounds and "length" (elements live in element storage, not the prop
// map) — including a numeric key (`0 in a`), which is coerced like a property key.
function main(): void {
  const a = [10, 20, 30];
  console.log(0 in a, 2 in a, 3 in a, -1 in a);   // true true false false
  console.log("0" in a, "2" in a, "5" in a);       // true true false
  console.log("length" in a);                       // true

  const o: any = { x: 1, f() { return 1; } };
  console.log("x" in o, "y" in o, "f" in o);       // true false true
  console.log("toString" in o, "hasOwnProperty" in o); // true true (inherited)

  // dynamic key
  const k = "x";
  console.log(k in o, "z" in o);                    // true false

  // numeric key on a plain object (coerces to "0")
  const num: any = { 0: "a", 1: "b" };
  console.log(0 in num, 1 in num, 2 in num);       // true true false

  // empty array
  console.log(0 in [], "length" in []);            // false true
}

main();
