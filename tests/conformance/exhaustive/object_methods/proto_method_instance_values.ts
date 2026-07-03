// Object.prototype methods (toString / valueOf / hasOwnProperty) read as first-class
// VALUES off an object instance: `const f = o.hasOwnProperty`. These are inherited
// from Object.prototype; reading them as a value (not calling) must yield the bound-
// able function, and an OWN property of any type shadows the inherited method (JS
// own->prototype order). V8 is the oracle.

function main(): void {
  // inherited method values: typeof "function", usable via .call / .bind / detached.
  const o = { a: 1, b: 2 };
  const has = o.hasOwnProperty as (k: string) => boolean;
  console.log(typeof has);                       // function
  console.log(has.call(o, "a"), has.call(o, "z")); // true false
  const hb = (o.hasOwnProperty as (k: string) => boolean).bind(o);
  console.log(hb("b"), hb("q"));                 // true false

  const ts = o.toString as () => string;
  console.log(typeof ts);                        // function
  console.log(ts.call(o));                       // [object Object]
  console.log((({} as object).toString as () => string).call({})); // [object Object]

  const vo = o.valueOf as () => unknown;
  console.log(typeof vo);                        // function

  // works on array / class instances too (inherited from Object.prototype)
  console.log(typeof [1, 2].toString, typeof [1, 2].hasOwnProperty); // function function
  class C { x = 1; }
  const c = new C();
  console.log(typeof c.hasOwnProperty, (c.hasOwnProperty as (k: string) => boolean).call(c, "x")); // function true

  // passed as a callback / used through a variable
  const keys = ["a", "z", "b"];
  console.log(keys.filter((k) => (has).call(o, k)).join(",")); // a,b

  // OWN property of ANY type shadows the inherited method (JS semantics)
  const m = { toString() { return "M"; } };
  console.log((m.toString as () => string).call(m)); // M (own method)
  const d: { toString: unknown } = { toString: 42 };
  console.log(d.toString);                       // 42 (own data shadows; not a function)
  const e: { hasOwnProperty: unknown } = { hasOwnProperty: "str" };
  console.log(e.hasOwnProperty);                 // str

  // own toString/valueOf still drive string/number coercion (regression)
  const s = { toString() { return "X"; } };
  console.log(`${s}`, String(s));                // X X
  const n = { valueOf() { return 5; } };
  console.log((n as { valueOf(): number }).valueOf() + 10); // 15
}

main();
