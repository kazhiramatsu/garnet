// A declared class field that no constructor assigns reads as `undefined`
// (V8 defines it as an own property holding undefined). The native instance
// struct comes from zeroed memory, where a zero word is the number 0 under
// NaN-boxing, so boxed fields must be explicitly initialized to undefined on
// every allocation path (heap, pretenured, stack, dynamic `new`).

class A {
  x?: number;
  y?: string;
  z!: object | undefined;
  w?: boolean;
}

class B {
  x: number;
  tag!: string | undefined;
  constructor() {
    // `x` is a definitely-assigned number: its unboxed slot cannot hold
    // undefined, so only the boxed field is observed before assignment here.
    console.log(this.tag === undefined, typeof this.tag);
    this.x = 1;
  }
}

class C extends A {
  extra?: number[];
}

function make(ctor: new () => A): A {
  return new ctor();
}

function main(): void {
  const a = new A();
  // (`"x" in a` is intentionally not observed: the ES2020 reference erases
  // uninitialized declarations while the native class keeps the own slot.)
  console.log(a.x, a.y, a.z, a.w, a.x ?? "dflt", a.y === undefined);
  const b = new B();
  console.log(b.x, b.tag);
  const c = new C();
  console.log(c.x, c.extra, c.extra ?? "none");
  const d = make(A);
  console.log(d.x, d.z);
  const list: A[] = [];
  for (let i = 0; i < 3; i++) list.push(new A());
  console.log(list.map(o => o.y).join(","), list.every(o => o.w === undefined));
}
main();
