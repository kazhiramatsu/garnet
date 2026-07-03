// Focused stress for movable Promise cells. Pending promises and combinator
// output promises are left suspended under allocation pressure, then settled
// through waiters / adoption / combinator adapters.
function churn(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o: any = { value: i, nested: [{ n: i + 1 }] };
    sum += o.value + o.nested[0].n;
  }
  return sum;
}

async function waitTag(p: Promise<any>): Promise<string> {
  const v = await p;
  churn(96);
  return v.tag + ":" + v.item.n;
}

async function addShared(p: Promise<number>, idx: number): Promise<number> {
  const base = await p;
  churn(48);
  return base + idx;
}

async function main(): Promise<void> {
  let resolveLater: (v: any) => void;
  const pending = new Promise<any>((resolve) => {
    resolveLater = resolve;
  });
  const waited = waitTag(pending);
  churn(256);
  resolveLater!({ tag: "payload", item: { n: 41 } });
  churn(256);
  console.log(await waited); // payload:41

  let resolveShared: (v: number) => void;
  const shared = new Promise<number>((resolve) => {
    resolveShared = resolve;
  });
  const many: Promise<number>[] = [];
  for (let i = 0; i < 24; i++) many.push(addShared(shared, i));
  churn(256);
  resolveShared!(10);
  churn(256);
  const manyValues = await Promise.all(many);
  console.log(manyValues[0] + ":" + manyValues[23] + ":" + manyValues.reduce((a, b) => a + b, 0)); // 10:33:516

  const resolvers: ((v: any) => void)[] = [];
  const inputs: Promise<any>[] = [];
  for (let i = 0; i < 6; i++) {
    inputs.push(new Promise<any>((resolve) => {
      resolvers.push(resolve);
    }));
  }
  const all = Promise.all(inputs);
  const race = Promise.race(inputs);
  const settled = Promise.allSettled(inputs);
  churn(256);
  resolvers[2]({ v: 3 });
  resolvers[0]({ v: 1 });
  resolvers[1]({ v: 2 });
  resolvers[3]({ v: 4 });
  resolvers[4]({ v: 5 });
  resolvers[5]({ v: 6 });
  churn(256);
  const allValues = await all;
  const raceValue: any = await race;
  const settledValues: any[] = await settled;
  console.log(allValues.map((x: any) => x.v).join(",") + ":" + raceValue.v + ":" + settledValues.length); // 1,2,3,4,5,6:3:6

  let resolveInner: (v: number) => void;
  const inner = new Promise<number>((resolve) => {
    resolveInner = resolve;
  });
  const outer = Promise.resolve(inner);
  churn(256);
  resolveInner!(77);
  churn(256);
  console.log(await outer); // 77

  let resolveChain: (v: number) => void;
  const chain = new Promise<number>((resolve) => {
    resolveChain = resolve;
  }).then((x) => {
    churn(96);
    return x + 1;
  }).finally(() => {
    churn(96);
  });
  churn(256);
  resolveChain!(20);
  churn(256);
  console.log(await chain); // 21
}

main();
