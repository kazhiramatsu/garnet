// Common real-world Proxy patterns: validation, default values, virtual
// properties, method interception, spreading/assign, array-target traps, and
// wrapping typed class instances (whose methods mutate `this.field` through the
// proxy — the struct-field fast path is proxy-guarded, so traps are honored).
function main(): void {
  // wrap a typed class instance: a mutating method reads/writes this.field
  // through the proxy (struct-field accesses are routed via ts_get/ts_set when
  // the receiver is a proxy).
  class Counter { n = 0; inc(): number { this.n++; return this.n; } }
  const cp: any = new Proxy(new Counter(), {});
  console.log(cp.inc(), cp.inc(), cp.n); // 1 2 2
  // get/set traps still intercept class-instance field access
  class Box { v = 5; }
  const ct: any = new Proxy(new Box(), { get(t: any, k: any) { return t[k] * 100; } });
  console.log(ct.v); // 500
  const sx: number[] = [];
  const cs: any = new Proxy(new Box(), { set(t: any, k: any, val: any) { sx.push(val); t[k] = val; return true; } });
  cs.v = 7;
  console.log(sx[0], cs.v); // 7 700 (get trap absent -> read v*?? no: cs has only set trap; cs.v reads target.v=7)

  // method call where the method lives on the (plain-object) target
  const m: any = new Proxy({ greet(n: string) { return "hi " + n; } }, {});
  console.log(m.greet("bob")); // hi bob

  // get trap returning a function, then calling it
  const gf: any = new Proxy({} as any, { get() { return (x: number) => x * 2; } });
  console.log(gf.anything(21)); // 42

  // validation via set trap (throws a catchable RangeError)
  const v: any = new Proxy({ age: 0 } as any, {
    set(t: any, k: any, val: any) { if (k === "age" && val < 0) throw new RangeError("neg"); t[k] = val; return true; },
  });
  v.age = 5;
  console.log(v.age); // 5
  try { v.age = -1; } catch (e: any) { console.log(e instanceof RangeError); } // true

  // default values for missing keys
  const d: any = new Proxy({} as any, { get(t: any, k: any) { return k in t ? t[k] : "default"; } });
  d.x = "set";
  console.log(d.x, d.missing); // set default

  // spreading and Object.assign route through ownKeys + get
  const o: any = new Proxy({ a: 1, b: 2, c: 3 }, {});
  console.log(JSON.stringify({ ...o })); // {"a":1,"b":2,"c":3}
  console.log(JSON.stringify(Object.assign({}, o))); // {"a":1,"b":2,"c":3}

  // array target: indices and length through traps / defaults
  const arr: any = new Proxy([10, 20, 30], { get(t: any, k: any) { return k === "length" ? t.length : t[k]; } });
  console.log(arr[0], arr[2], arr.length); // 10 30 3
  const arr2: any = new Proxy([1, 2, 3, 4], {});
  console.log(arr2.length, arr2[3]); // 4 4

  // logging wrapper that counts get accesses
  let reads = 0;
  const counter: any = new Proxy({ p: 1, q: 2 }, { get(t: any, k: any) { reads++; return t[k]; } });
  void counter.p; void counter.q; void counter.p;
  console.log(reads); // 3
}
main();
