// Focused stress for movable Coro cells. Coroutines are suspended, allocation
// pressure runs while their frames are not executing, and then they are resumed
// through Promise waiters / generator objects.
function churn(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o: any = { value: i, nested: [{ n: i + 1 }] };
    sum += o.value + o.nested[0].n;
  }
  return sum;
}

async function waitThenAdd(p: Promise<any>): Promise<number> {
  const v = await p;
  churn(96);
  return v.n + 1;
}

async function catchRejected(p: Promise<any>): Promise<string> {
  try {
    await p;
    return "no";
  } catch (e: any) {
    churn(96);
    return "caught:" + e.message;
  }
}

function* catchThrow(): Generator<any> {
  try {
    const sent: any = yield { v: 1 };
    yield { v: sent.v + 1 };
  } catch (e: any) {
    yield { v: "caught:" + e.message };
  }
  return { v: "done" };
}

async function* asyncSeq(): AsyncGenerator<any> {
  yield { v: 3 };
  churn(96);
  const sent: any = yield await Promise.resolve({ v: 4 });
  return { v: sent.v + 1 };
}

async function main(): Promise<void> {
  let resolveLater: (v: any) => void;
  const pending = new Promise<any>((resolve) => {
    resolveLater = resolve;
  });
  const waited = waitThenAdd(pending);
  churn(256);
  resolveLater!({ n: 40 });
  churn(256);
  console.log(await waited); // 41

  let rejectLater: (v: any) => void;
  const rejected = new Promise<any>((_resolve, reject) => {
    rejectLater = reject;
  });
  const caught = catchRejected(rejected);
  churn(256);
  rejectLater!(new Error("boom"));
  churn(256);
  console.log(await caught); // caught:boom

  const it = catchThrow();
  const g1: any = it.next();
  churn(256);
  const g2: any = it.next({ v: 7 });
  churn(256);
  const it2 = catchThrow();
  it2.next();
  churn(256);
  const g3: any = it2.throw(new Error("x"));
  churn(256);
  const g4: any = it2.next();
  console.log(g1.value.v + ":" + g2.value.v + ":" + g3.value.v + ":" + g4.value.v + ":" + g4.done); // 1:8:caught:x:done:true

  const ag = asyncSeq();
  const a1: any = await ag.next();
  churn(256);
  const a2: any = await ag.next({ v: 9 });
  churn(256);
  const a3: any = await ag.next({ v: 20 });
  console.log(a1.value.v + ":" + a2.value.v + ":" + a3.value.v + ":" + a3.done); // 3:4:21:true
}

main();
