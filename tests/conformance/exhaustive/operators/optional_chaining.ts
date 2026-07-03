function main(): void {
  // Optional property access short-circuits on a null/undefined receiver.
  const a: any = null;
  console.log(a?.x);                         // undefined
  console.log(a?.x.y.z);                     // undefined (whole tail skipped)
  console.log(a?.[0]);                       // undefined

  // Present receiver: the chain evaluates normally.
  const o: any = { b: { c: { d: 42 } }, f: () => 9 };
  console.log(o?.b.c.d);                     // 42
  console.log(o?.b?.c?.d);                   // 42

  // Optional CALL: missing method yields undefined (no "not a function" trap);
  // present method calls normally.
  console.log(o.missing?.());               // undefined
  console.log(o.f?.());                      // 9

  // Optional call directly on a nullish value.
  const nf: any = null;
  console.log(nf?.());                       // undefined

  // Short-circuit must NOT evaluate the skipped tail's side effects.
  let n = 0;
  const r1 = a?.b[(n++, 0)];
  console.log(r1, n);                        // undefined 0
  const r2 = nf?.f(n++);
  console.log(r2, n);                        // undefined 0

  // The part BEFORE the first `?.` always runs (and exactly once).
  let calls = 0;
  const get = (): any => { calls++; return null; };
  console.log(get()?.x, calls);              // undefined 1

  // Multi-guard: an intermediate null short-circuits the rest.
  const m: any = { b: null };
  console.log(m?.b?.c);                      // undefined

  // Combine with the nullish-coalescing default.
  console.log(o?.z?.d ?? 99);                // 99
  console.log(o?.b.c.d ?? 99);               // 42

  // Optional chaining on a typed class instance (exercises SROA interaction).
  class C { x = 5; twice(): number { return this.x * 2; } add(a: number, b: number): number { return a + b; } }
  const c: C | null = new C();
  console.log(c?.x);                         // 5
  console.log(c?.twice());                   // 10
  console.log(c?.add(3, 4));                 // 7 (optional call passes arguments)
  const cn: C | null = null;
  console.log(cn?.x);                        // undefined
  console.log(cn?.twice());                  // undefined

  // Optional method call on a builtin (array) receiver.
  const arr: number[] | null = [1, 2, 3];
  console.log(arr?.map((v) => v * 10).join(","));   // 10,20,30
  const arrn: number[] | null = null;
  console.log(arrn?.length);                 // undefined
}
main();
