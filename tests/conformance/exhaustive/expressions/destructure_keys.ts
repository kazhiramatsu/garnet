// Object destructuring property keys: computed `{[k]: name}`, string-literal
// `{"a": name}`, and numeric `{0: name}` keys must read the NAMED property — not
// fall back to the binding name (a silent miscompile that read the wrong field).
function main(): void {
  // computed key (identifier)
  const key = "a";
  const { [key]: val } = { a: 42, b: 5 };
  console.log(val);                               // 42

  // computed key (string literal)
  const { ["b"]: v2 } = { a: 1, b: 7 };
  console.log(v2);                                 // 7

  // computed key with default
  const { [key]: v3 = 99 } = {} as any;
  console.log(v3);                                 // 99

  // computed numeric key from an array
  const idx = 1;
  const { [idx]: e } = ["x", "y", "z"];
  console.log(e);                                  // y

  // string-literal property name
  const { "a": sa, "b": sb } = { a: 10, b: 20 };
  console.log(sa, sb);                             // 10 20

  // numeric property name
  const { 0: n0, 1: n1 } = { 0: "p", 1: "q" };
  console.log(n0, n1);                             // p q

  // regression: shorthand, rename, default, nested, rest
  const { a, b } = { a: 1, b: 2 };
  console.log(a, b);                               // 1 2
  const { a: rx, c: rz = 9 } = { a: 5 } as any;
  console.log(rx, rz);                             // 5 9
  const { a: { b: nb } } = { a: { b: 3 } };
  console.log(nb);                                 // 3
  const { a: first, ...others } = { a: 1, b: 2, c: 3 };
  console.log(first, JSON.stringify(others));      // 1 {"b":2,"c":3}

  // computed key in a function parameter pattern
  function pick({ [key]: picked }: any) { return picked; }
  console.log(pick({ a: 8 }));                      // 8
}

main();
