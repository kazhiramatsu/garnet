// Async-generator requests are FIFO, yielded/returned values are awaited, and
// close operations run finally before the request promise settles.
async function* queued(
  wait: Promise<number>,
): AsyncGenerator<number, number, unknown> {
  yield wait;
  yield Promise.resolve(20) as any;
  return Promise.resolve(30) as any;
}

async function* closable(): AsyncGenerator<number, number, unknown> {
  try {
    yield 1;
    yield 2;
    return 3;
  } finally {
    await Promise.resolve(undefined);
    console.log("async-closed");
  }
}

async function main(): Promise<void> {
  let release: (value: number) => void;
  const wait = new Promise<number>((resolve) => { release = resolve; });
  const gen = queued(wait);
  const first = gen.next();
  const second = gen.next();
  const third = gen.next();
  release!(10);
  const a = await first;
  const b = await second;
  const c = await third;
  console.log(a.value, a.done); // 10 false
  console.log(b.value, b.done); // 20 false
  console.log(c.value, c.done); // 30 true

  const closed = closable();
  console.log((await closed.next()).value); // 1
  const returned = await closed.return(Promise.resolve(9) as any);
  console.log(returned.value, returned.done); // async-closed, then 9 true

  const neverStarted = closable();
  const beforeStart = await neverStarted.return(Promise.resolve(11) as any);
  console.log(beforeStart.value, beforeStart.done); // 11 true

  let sum = 0;
  for await (const value of closable()) {
    sum += value;
    break;
  }
  console.log(sum); // async-closed, then 1
}

main();
