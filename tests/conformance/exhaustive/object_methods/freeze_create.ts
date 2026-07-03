function main(): void {
  // ESM/TS is always strict: writes to a frozen object throw a TypeError
  // (matching V8's message exactly so try/catch sees identical e.message).
  const o: any = Object.freeze({ a: 1 });
  try { o.a = 2; } catch (e) { console.log((e as Error).message); } // read only property 'a'
  try { o.b = 3; } catch (e) { console.log((e as Error).message); } // add property b, not extensible
  console.log(o.a, o.b);                       // 1 undefined

  // freeze returns the same object.
  const t: any = { x: 5 };
  console.log(Object.freeze(t) === t, t.x);    // true 5

  // Object.isFrozen.
  console.log(Object.isFrozen(Object.freeze({ a: 1 })), Object.isFrozen({ b: 2 })); // true false

  // a frozen array's element write throws.
  const arr: any = Object.freeze([1, 2, 3]);
  try { arr[0] = 9; } catch (e) { console.log((e as Error).message); }
  console.log(arr[0], arr.length);             // 1 3

  // Nested objects are NOT deep-frozen (matches JS shallow freeze).
  const n: any = Object.freeze({ a: { b: 1 } });
  n.a.b = 2;
  console.log(n.a.b);                          // 2

  // Object.create(null): a bare object with no prototype.
  const bare: any = Object.create(null);
  bare.x = 5;
  console.log(bare.x);                         // 5

  // Object.create(proto): the new object inherits proto's methods/fields.
  const proto: any = { base: 10, greet(): string { return "hi"; } };
  const c: any = Object.create(proto);
  c.own = 7;
  console.log(c.base, c.own, c.greet());       // 10 7 hi
}
main();
