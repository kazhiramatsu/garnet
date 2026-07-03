// Promise/coroutine GC edges are stored as stable handles: pending waiters,
// queued microtasks, coroutine return promises, and async-generator next promises
// must survive young collections under allocation pressure.
function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const o: any = { value: i };
    sum += o.value;
    i++;
  }
  return sum;
}

async function waitTag(p: Promise<any>): Promise<number> {
  const v = await p;
  churn(70000);
  return v.tag;
}

async function* seq(): AsyncGenerator<number> {
  yield await Promise.resolve(5);
  churn(70000);
  yield 6;
}

async function main(): Promise<void> {
  let resolveLater: (v: any) => void;
  const pending = new Promise<any>((resolve) => {
    resolveLater = resolve;
  });
  const out = waitTag(pending);
  const payload: any = { tag: 41 };
  churn(70000);
  resolveLater!(payload);
  churn(70000);
  console.log(await out); // 41

  const resolvers: ((v: number) => void)[] = [];
  const inputs: Promise<number>[] = [];
  for (let i = 0; i < 8; i++) {
    inputs.push(new Promise<number>((resolve) => {
      resolvers.push(resolve);
    }));
  }
  const all = Promise.all(inputs);
  churn(70000);
  for (let i = 0; i < resolvers.length; i++) resolvers[i](i + 1);
  churn(70000);
  const values = await all;
  console.log(values.reduce((a, b) => a + b, 0)); // 36

  let resolveMany: (v: number) => void;
  const shared = new Promise<number>((resolve) => {
    resolveMany = resolve;
  });
  const many: Promise<number>[] = [];
  for (let i = 0; i < 40; i++) {
    many.push((async (idx: number): Promise<number> => {
      const base = await shared;
      churn(70000);
      return base + idx;
    })(i));
  }
  churn(70000);
  resolveMany!(100);
  churn(70000);
  const manyValues = await Promise.all(many);
  console.log(manyValues[0] + ":" + manyValues[39] + ":" + manyValues.reduce((a, b) => a + b, 0)); // 100:139:4780

  let genSum = 0;
  for await (const x of seq()) {
    churn(70000);
    genSum += x;
  }
  console.log(genSum); // 11
}

main();
