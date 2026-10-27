// garnet real-project benchmark: rxjs 7 (benchmarks/real/run.sh rxjs). Synchronous pipelines over ranges and
// subjects (map, filter, scan, mergeMap, take, zip, merge, a Subject with several subscribers), no scheduler;
// the checksum adds the emitted values and the completion counts, so the native and the Node runs must agree.
import { range, of, from, zip, merge, Subject, map, filter, scan, mergeMap, take, reduce, concatMap, distinctUntilChanged, pairwise } from "./src/index.ts";
import { performance } from "node:perf_hooks";

function pipelines(n: number): number {
  let acc = 0, completed = 0;
  range(0, n).pipe(map((x) => x * 3), filter((x) => x % 2 === 0), scan((a, x) => a + x, 0)).subscribe({ next: (v) => { acc = (acc + v) | 0; }, complete: () => { completed++; } });
  range(0, n / 10).pipe(mergeMap((x) => of(x, x + 1, x + 2)), take(n / 2), reduce((a, x) => a + x, 0)).subscribe({ next: (v) => { acc = (acc + v) | 0; }, complete: () => { completed++; } });
  zip(range(0, n / 4), range(100, n / 4)).pipe(map(([a, b]) => a + b)).subscribe({ next: (v) => { acc = (acc + v) | 0; }, complete: () => { completed++; } });
  merge(range(0, n / 8), from([1, 2, 3, 4, 5])).pipe(pairwise(), map(([a, b]) => b - a), distinctUntilChanged()).subscribe({ next: (v) => { acc = (acc + v) | 0; }, complete: () => { completed++; } });
  from(Array.from({ length: n / 20 }, (_, i) => i)).pipe(concatMap((x) => range(x, 3))).subscribe({ next: (v) => { acc = (acc + v) | 0; }, complete: () => { completed++; } });
  return acc + completed;
}
function subjects(n: number): number {
  const s = new Subject<number>();
  let total = 0;
  const subs = [s.pipe(map((x) => x + 1)).subscribe((v) => { total += v; }), s.pipe(filter((x) => (x & 1) === 0)).subscribe((v) => { total += v; }), s.subscribe((v) => { total -= v; })];
  for (let i = 0; i < n; i++) s.next(i);
  s.complete();
  for (const sub of subs) sub.unsubscribe();
  return total;
}
function main(): void {
  const t0 = performance.now();
  let sum = 0;
  for (let it = 0; it < 40; it++) { sum = (sum + pipelines(20000)) | 0; sum = (sum + subjects(50000)) | 0; }
  const ms = performance.now() - t0;
  process.stderr.write(`rxjs: ${ms.toFixed(1)} ms (40 rounds of pipelines and subjects)\n`);
  console.log(`rxjs: sum ${sum}`);
}
main();
