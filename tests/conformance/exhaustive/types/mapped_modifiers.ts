interface Src { a: number; b: string; readonly c: boolean; d?: number; }
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type AllRequired<T> = { [K in keyof T]-?: T[K] };
type AllOptional<T> = { [K in keyof T]+?: T[K] };
type Renamed<T> = { [K in keyof T as `f_${string & K}`]: T[K] };
type Getters<T> = { [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K] };

function main(): void {
  const m: Mutable<Src> = { a: 1, b: "x", c: true };
  m.c = false;                                      // allowed (readonly stripped)
  console.log(m.a, m.b, m.c);                       // 1 x false
  const r: AllRequired<Src> = { a: 1, b: "y", c: true, d: 9 };
  console.log(r.d);                                 // 9
  const o: AllOptional<Src> = {};
  console.log(o.a ?? -1);                           // -1
  const rn: Renamed<Src> = { f_a: 1, f_b: "z", f_c: false };
  console.log(rn.f_a, rn.f_b);                      // 1 z
  const g: Getters<{ x: number }> = { getX: () => 42 };
  console.log(g.getX());                            // 42
}
main();
