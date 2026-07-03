// Moving-minor stress around the non-moving Promise/Coro boundary. Run this
// with TSAOT_GC_YOUNG_THRESHOLD set low to force relocation between awaits,
// generator wrapping, iterator stepping, and async-generator next promises.
function churn(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o: any = { value: i, nested: [{ n: i + 1 }] };
    sum += o.value + o.nested[0].n;
  }
  return sum;
}

async function waitPayload(p: Promise<any>): Promise<string> {
  const v = await p;
  churn(64);
  return v.tag + ":" + v.items[0].n;
}

class DelegatedIterator {
  private i = 0;
  [Symbol.iterator](): DelegatedIterator { return this; }
  next(sent?: any): { value: any; done: boolean } {
    churn(16);
    this.i++;
    if (this.i === 1) return { value: { v: 10, sent: sent ? 1 : 0 }, done: false };
    if (this.i === 2) return { value: { v: 20, sent: sent ? sent.v : 0 }, done: false };
    return { value: { v: 30 }, done: true };
  }
}

function* syncSeq(): Generator<any> {
  yield { v: 1 };
  churn(32);
  yield { v: 2 };
  return { v: 99 };
}

function* delegatedSeq(): Generator<any> {
  const r: any = yield* new DelegatedIterator();
  return { v: r.v + 1 };
}

async function* asyncSeq(): AsyncGenerator<any> {
  yield await Promise.resolve({ v: 3 });
  churn(32);
  const sent: any = yield { v: 4 };
  churn(32);
  return { v: sent.v };
}

async function main(): Promise<void> {
  let resolveLater: (v: any) => void;
  const pending = new Promise<any>((resolve) => {
    resolveLater = resolve;
  });
  const out = waitPayload(pending);
  const payload: any = { tag: "payload", items: [{ n: 1 }] };
  churn(128);
  resolveLater!(payload);
  churn(128);
  console.log(await out); // payload:1

  const inputs: Promise<any>[] = [];
  for (let i = 0; i < 6; i++) inputs.push(Promise.resolve({ v: i }));
  churn(128);
  const values = await Promise.all(inputs);
  console.log(values.map((x: any) => x.v).join(",")); // 0,1,2,3,4,5

  const it = syncSeq();
  const a: any = it.next();
  churn(128);
  const b: any = it.next({ sent: true });
  churn(128);
  const c: any = it.return({ v: 7 });
  console.log(a.value.v + ":" + b.value.v + ":" + c.value.v + ":" + c.done); // 1:2:7:true

  const di = delegatedSeq();
  const d1: any = di.next();
  churn(128);
  const d2: any = di.next({ v: 5 });
  churn(128);
  const d3: any = di.next();
  console.log(d1.value.v + ":" + d2.value.v + ":" + d3.value.v + ":" + d3.done); // 10:20:31:true

  const ag = asyncSeq();
  const ag1: any = await ag.next({ ignored: true });
  churn(128);
  const ag2: any = await ag.next({ v: 8 });
  churn(128);
  const ag3: any = await ag.next({ v: 8 });
  console.log(ag1.value.v + ":" + ag2.value.v + ":" + ag3.value.v + ":" + ag3.done); // 3:4:8:true
}

main();
