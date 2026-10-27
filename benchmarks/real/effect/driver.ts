// garnet real-project benchmark: effect 3.x (benchmarks/real/run.sh effect; the clone is the latest effect@3
// release tag, the main branch requires TypeScript 7). The modules are imported directly: `index.ts` re-exports
// `Schema`, whose `FastCheck` dependency is the npm package fast-check (no sources in the clone). Three
// programs run synchronously: a generator loop of effects, a stream pipeline, and Option/Either/Array
// combinators over records; the checksum adds their results, so the native and the Node runs must agree.
import * as Effect from "./packages/effect/src/Effect.ts";
import * as Stream from "./packages/effect/src/Stream.ts";
import * as Option from "./packages/effect/src/Option.ts";
import * as Either from "./packages/effect/src/Either.ts";
import * as Arr from "./packages/effect/src/Array.ts";
import { pipe } from "./packages/effect/src/Function.ts";
import { performance } from "node:perf_hooks";

const sumLoop = (n: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += yield* Effect.succeed(i);
    return acc;
  });
const streamSum = (n: number): Effect.Effect<number> =>
  Stream.range(0, n).pipe(
    Stream.map((x) => x * 2),
    Stream.filter((x) => x % 3 === 0),
    Stream.runFold(0, (a, b) => a + b)
  );
/** A record validated with Option and Either combinators (the Schema module needs fast-check). */
function checkRec(r: { id: number; name: string; tags: string[]; active: boolean }): number {
  const id = pipe(Option.liftPredicate(r.id, (n: number) => n >= 0), Option.getOrElse(() => -1));
  const name = pipe(Either.liftPredicate(r.name, (s: string) => s.length > 0, () => "empty"), Either.match({ onLeft: () => 0, onRight: (s) => s.length }));
  const tags = pipe(r.tags, Arr.filter((t) => t !== ""), Arr.map((t) => t.length), Arr.reduce(0, (a, b) => a + b));
  return id + name + tags + (r.active ? 1 : 0);
}
function main(): void {
  const t0 = performance.now();
  const a = Effect.runSync(sumLoop(200000));
  const b = Effect.runSync(streamSum(200000));
  let c = 0;
  for (let i = 0; i < 100000; i++) c += checkRec({ id: i, name: "n" + i, tags: ["a", "b"], active: i % 2 === 0 });
  const ms = performance.now() - t0;
  process.stderr.write(`effect: ${ms.toFixed(1)} ms\n`);
  console.log(`effect: gen ${a} stream ${b} records ${c}`);
}
main();
