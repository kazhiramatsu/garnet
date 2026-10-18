// A `return` inside a try/catch that contains no await/yield, in an async
// function or generator. The try itself needs no suspension support, but the
// return must still complete the coroutine (resolve the promise / finish the
// generator) and pop the try's handler. Emitting it as a raw native return left
// the promise pending forever (the program just exited silently) and a stale
// handler behind.

async function f(x: number): Promise<number> {
  try {
    if (x > 0) return 1;
  } catch (e) {
    return -1;
  }
  return 0;
}

async function g(x: number): Promise<number> {
  try {
    if (x > 0) return 2;
    throw new Error("no");
  } catch (e) {
    return -2;
  }
}

async function nested(x: number): Promise<number> {
  try {
    try {
      if (x > 0) return 3;
    } catch (e) {
      return -3;
    }
  } catch (e2) {
    return -4;
  }
  return 0;
}

async function afterAwait(x: number): Promise<number> {
  const y = await Promise.resolve(x);
  try {
    if (y > 0) return y + 10;
  } catch (e) {
    return -5;
  }
  return 0;
}

function* gen(x: number): Generator<number, number, unknown> {
  yield 1;
  try {
    if (x > 0) return 7;
  } catch (e) {
    return -7;
  }
  return 0;
}

async function main(): Promise<void> {
  console.log(await f(1), await f(0), await g(1), await g(0));
  console.log(await nested(1), await afterAwait(5));
  const it = gen(1);
  console.log(JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()));
  // The throw must reach THIS catch, not a handler left behind by f/g/nested.
  try {
    await f(1);
    await g(1);
    await nested(1);
    throw new Error("y");
  } catch (e: any) {
    console.log("caught", e.message);
  }
  console.log("end");
}
main();
