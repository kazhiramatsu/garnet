// Coroutine entry points allocate a frame and must publish/root its stable handle
// before running the body or wrapping it in a generator object. This covers the
// handle-first async/generator/async-generator entry path under allocation stress.
function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const o: any = { value: i, nested: [{ n: i + 1 }] };
    sum += o.value + o.nested[0].n;
    i++;
  }
  return sum;
}

async function asyncNum(x: number): Promise<number> {
  churn(70000);
  return x + 1;
}

function* genNum(x: number): Generator<number> {
  churn(70000);
  yield x + 2;
}

async function* asyncGenNum(x: number): AsyncGenerator<number> {
  churn(70000);
  yield x + 3;
}

async function main(): Promise<void> {
  console.log(await asyncNum(10)); // 11
  console.log([...genNum(20)].join(",")); // 22
  const r: any = await asyncGenNum(30).next();
  console.log(r.value, r.done); // 33 false
}

main();
