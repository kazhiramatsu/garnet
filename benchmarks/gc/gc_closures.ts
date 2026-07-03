// GC bench: クロージャ churn（env alloc + ts_call の毎呼び出し malloc）。
// RT_STATS の call_env_malloc カウンタの主対象。
function mk(x: number): () => number {
  return () => x + 1;
}
function main(): void {
  const fns: (() => number)[] = [];
  for (let i = 0; i < 32; i++) fns.push(mk(i));
  let acc = 0;
  for (let i = 0; i < 2000000; i++) {
    const f = mk(i);
    acc = (acc + f() + fns[i & 31]()) % 1000000007;
  }
  console.log("gc_closures " + acc);
}
main();
