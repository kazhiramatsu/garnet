type Unpromise<T> = T extends Promise<infer U> ? U : T;
type First<T extends any[]> = T extends [infer F, ...any[]] ? F : never;
type Last<T extends any[]> = T extends [...any[], infer L] ? L : never;
type RetType<T> = T extends (...a: any[]) => infer R ? R : never;
type ElemOf<T> = T extends (infer E)[] ? E : never;

function head<T extends any[]>(t: T): First<T> { return t[0]; }
function tail2<T extends any[]>(t: T): Last<T> { return t[t.length - 1]; }

function main(): void {
  const a: First<[number, string]> = 5;
  const b: Last<[number, string, boolean]> = true;
  const r: RetType<() => string> = "ret";
  const e: ElemOf<number[]> = 9;
  const u: Unpromise<Promise<number>> = 7;
  console.log(a, b, r, e, u);                       // 5 true ret 9 7
  console.log(head([10, "x"]), tail2([1, 2, 3]));   // 10 3
}
main();
