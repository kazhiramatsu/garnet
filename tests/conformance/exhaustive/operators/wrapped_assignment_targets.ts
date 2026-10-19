// Assignment targets wrapped in parentheses or type assertions (`o.f! |= v`,
// `(o.f as number) += 1`, `(o as T).f = v`, `o.f!++`): the wrappers do not
// change the reference. A wrapped compound-assignment target used to fall
// through every branch of the target lowering and drop the store silently
// (Session 350, x34); every form must now match V8, including targets whose
// object expression has side effects (evaluated once) and element targets.
interface T { f?: number; g?: string; arr?: number[]; }
let calls = 0;
function get(o: T): T { calls++; return o; }
function main(): void {
  const o: T = { f: 2, g: "a", arr: [1, 2, 3] };
  o.f! |= 64;
  o.g! += "b";
  (o.f as number) += 1;
  (o as T).f! -= 1;
  (o.f) = (o.f as number) * 2;
  o.f! = o.f! + 1;
  o.arr![1] += 10;
  (o.arr as number[])[2] *= 3;
  get(o).f! += 100;
  (get(o) as T).g! += "c";
  console.log(o.f, o.g, o.arr!.join(","), calls);
  o.f!++; ++o.f!; (o.f as number)--; o.arr![0]++;
  console.log(o.f, o.arr![0]);
  let n: number | undefined = 5;
  n! += 1; (n as number) *= 2; n!++;
  console.log(n);
  const list: T[] = [{ f: 1 }, { f: 2 }];
  for (const t of list) (t.f as number) **= 2;
  (list[1] as T).g = "set";
  console.log(list.map((t) => t.f).join(","), list[1].g, Object.keys(list[1]).join(","));
}
main();
