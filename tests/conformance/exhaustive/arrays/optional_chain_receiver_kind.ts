// The receiver of a method after an optional chain is typed `T | undefined`: an array of promises
// (`cbs?.map(..).filter(..).forEach(..)`, hono's streaming renderer) is an array receiver, a string
// one a string receiver, as the member without undefined says. The printed "Promise<string>[] |
// undefined" classified the first as a promise, a compile-time reject.
type Cb = (n: number) => Promise<string> | undefined;
function run(cbs: Cb[] | undefined, s: string | undefined, xs: number[] | undefined): Promise<void> {
  const seen: string[] = [];
  const then = (p: Promise<string>): void => { p.then((v) => seen.push(v)); };
  cbs?.map((c) => c(1)).filter<Promise<string>>(Boolean as never).forEach(then);
  const upper = s?.toUpperCase().split("-");
  const total = xs?.map((x) => x * 2).reduce((a, b) => a + b, 0);
  return new Promise<void>((resolve) => setTimeout(() => { console.log(seen.sort(), upper, total); resolve(); }, 0));
}
async function main(): Promise<void> {
  await run([(n) => Promise.resolve("a" + n), () => undefined, (n) => Promise.resolve("b" + n)], "x-y", [1, 2]);
  await run(undefined, undefined, undefined);
}
main();
