function main(): void {
  // ESM/TS strict mode: on a sealed object, modifying an existing property is
  // allowed, but ADD and DELETE throw a TypeError.
  const s: any = Object.seal({ a: 1 });
  s.a = 9;                                                       // allowed (existing)
  try { s.b = 2; } catch (e) { console.log((e as Error).message); }   // cannot add
  try { delete s.a; } catch (e) { console.log((e as Error).message); } // cannot delete
  console.log(s.a, s.b);                        // 9 undefined
  console.log(Object.isSealed(s), Object.isSealed({ a: 1 })); // true false

  // Object.preventExtensions: ADD throws; existing writes AND deletes are allowed.
  const p: any = Object.preventExtensions({ a: 1, b: 2 });
  p.a = 7;                                                       // allowed
  try { p.c = 3; } catch (e) { console.log((e as Error).message); }   // cannot add
  delete p.b;                                                   // allowed (still configurable)
  console.log(p.a, "b" in p, p.c);              // 7 false undefined
  console.log(Object.isExtensible({}), Object.isExtensible(p)); // true false

  // Frozen objects are also sealed and non-extensible.
  const f: any = Object.freeze({ a: 1 });
  console.log(Object.isSealed(f), Object.isExtensible(f), Object.isFrozen(f)); // true false true

  // Sealed is not frozen (values still mutable).
  console.log(Object.isFrozen(Object.seal({ a: 1 })));  // false
}
main();
