function main(): void {
  // A function value stored in an object field, called as `o.fn(args)`, is
  // dispatched dynamically (the receiver is `any`). An arrow / plain function
  // value does NOT consume a `this` slot, so its parameters must line up with
  // the call arguments — the receiver is dropped, not passed as the first arg.
  const o: any = {
    a: () => 7,
    b: (x: number) => x + 1,
    c: (x: number, y: number) => x * y,
  };
  console.log(o.a());                        // 7
  console.log(o.b(5));                       // 6
  console.log(o.c(3, 4));                     // 12

  // A real method (shorthand syntax) DOES read `this`; the receiver stays in
  // slot 0 and the arguments follow it.
  const m: any = {
    base: 100,
    f(p: number, q: number): number { return this.base + p + q; },
  };
  console.log(m.f(2, 3));                      // 105

  // Spread arguments through a field-stored arrow.
  const adder: any = { g: (a: number, b: number, c: number) => a + b + c };
  const xs = [10, 20, 30];
  console.log(adder.g(...xs));                 // 60

  // A class method invoked through an any-typed reference (dynamic dispatch)
  // must still receive its arguments correctly (and keep `this`).
  class C {
    v = 3;
    add(a: number, b: number): number { return this.v + a + b; }
    sum(...rest: number[]): number { let s = this.v; for (const r of rest) s += r; return s; }
  }
  const c: any = new C();
  console.log(c.add(4, 5));                    // 12
  console.log(c.sum(1, 2, 3));                 // 9

  // Inherited method through an any-typed reference.
  class A { greet(n: number): number { return n + 1; } }
  class B extends A {}
  const b: any = new B();
  console.log(b.greet(41));                    // 42

  // Object.prototype + builtin prototype methods via dynamic dispatch.
  const plain: any = { k: 1 };
  console.log(plain.hasOwnProperty("k"), plain.hasOwnProperty("z"));  // true false
  const arr: any = [1, 2, 3, 4];
  console.log(arr.reduce((p: number, n: number) => p + n, 0));        // 10

  // Function.prototype.call / apply / bind.
  function sub(this: any, p: number, q: number): number { return p - q; }
  console.log(sub.call(null, 10, 3));          // 7
  console.log(sub.apply(null, [9, 2]));        // 7
  console.log(sub.bind(null, 20)(5));          // 15
}
main();
