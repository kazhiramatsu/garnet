// Proxy essential-internal-method invariants (ECMA-262 9.5.x): a trap that
// violates the target's non-configurable / non-extensible constraints throws a
// catchable TypeError. Also: a present-but-non-callable trap, and operations on
// a revoked proxy, throw TypeError. Plus Proxy.revocable.
function main(): void {
  // get: non-configurable non-writable data prop -> trap must return SameValue
  const t1: any = {};
  Object.defineProperty(t1, "x", { value: 1, writable: false, configurable: false });
  const p1: any = new Proxy(t1, { get() { return 99; } });
  try { p1.x; console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true
  // matching value is allowed
  const p1ok: any = new Proxy(t1, { get() { return 1; } });
  console.log(p1ok.x); // 1

  // set: non-configurable non-writable -> trap cannot report a different value
  const t2: any = {};
  Object.defineProperty(t2, "y", { value: 5, writable: false, configurable: false });
  const p2: any = new Proxy(t2, { set() { return true; } });
  try { p2.y = 7; console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // has: cannot hide a non-configurable own property
  const t3: any = {};
  Object.defineProperty(t3, "z", { value: 1, configurable: false });
  const p3: any = new Proxy(t3, { has() { return false; } });
  try { "z" in p3; console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // getPrototypeOf: non-extensible target -> must report the real prototype
  const t4: any = {};
  Object.preventExtensions(t4);
  const p4: any = new Proxy(t4, { getPrototypeOf() { return {}; } });
  try { Object.getPrototypeOf(p4); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // construct: trap must return an object
  const c1: any = new Proxy(function () {}, { construct() { return 5; } });
  try { new c1(); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // getOwnPropertyDescriptor: trap must return object or undefined
  const od: any = new Proxy({}, { getOwnPropertyDescriptor() { return 5 as any; } });
  try { Object.getOwnPropertyDescriptor(od, "x"); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // a present-but-non-callable trap is a TypeError
  const nf: any = new Proxy({ a: 1 }, { get: 5 as any });
  try { nf.a; console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // ownKeys trap must return an array
  const ok: any = new Proxy({}, { ownKeys() { return 5 as any; } });
  try { Object.keys(ok); console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true

  // Proxy.revocable: works until revoked, then every operation throws
  const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
  console.log((proxy as any).a); // 1
  revoke();
  try { (proxy as any).a; console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true
  try { (proxy as any).b = 2; console.log("no throw"); } catch (e: any) { console.log(e instanceof TypeError); } // true
}
main();
