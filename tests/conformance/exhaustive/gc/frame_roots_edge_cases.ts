// Shadow-frame edge cases: normal/early returns, finally dispatch, rethrow,
// nested handlers, loop-local objects, deep numeric-specialized recursion, and
// a plain-frame -> coroutine catch followed by suspension.
function allocateBurst(count: number): number {
  let checksum = 0;
  for (let i = 0; i < count; i++) {
    const temporary: any = { i, nested: { value: i + 1 } };
    checksum += temporary.nested.value;
  }
  return checksum;
}

function earlyReturnThroughFinally(flag: boolean): string {
  const held: any = { value: flag ? "early" : "normal" };
  try {
    if (flag) {
      return held.value;
    }
    return held.value + "-return";
  } finally {
    const guard: any = { checksum: allocateBurst(200) };
    if (guard.checksum < 0) {
      console.log("unreachable");
    }
  }
}

console.log(earlyReturnThroughFinally(true), earlyReturnThroughFinally(false));

function throwThroughFinally(marker: string): never {
  const held: any = { marker };
  try {
    throw held;
  } finally {
    const guard: any = { checksum: allocateBurst(250) };
    if (guard.checksum < 0) {
      console.log("unreachable");
    }
  }
}

try {
  throwThroughFinally("finally-throw");
} catch (error: any) {
  console.log(error.marker);
}

function catchAndRethrow(marker: string): never {
  const outer: any = { marker };
  try {
    const inner: any = { outer };
    throw inner;
  } catch (error: any) {
    const retained: any = { error };
    allocateBurst(200);
    throw retained.error.outer;
  } finally {
    allocateBurst(200);
  }
}

try {
  catchAndRethrow("rethrow");
} catch (error: any) {
  console.log(error.marker);
}

function nestedHandlers(mode: number): string {
  const outer: any = { value: "outer-" + mode };
  try {
    try {
      const inner: any = { value: "inner-" + mode };
      if (mode === 0) {
        return inner.value;
      }
      throw inner;
    } catch (error: any) {
      const caught: any = { error, outer };
      allocateBurst(150);
      if (mode === 1) {
        return caught.error.value + ":" + caught.outer.value;
      }
      throw caught;
    } finally {
      allocateBurst(150);
    }
  } catch (error: any) {
    const after: any = { error };
    allocateBurst(150);
    return after.error.error.value + ":" + after.error.outer.value;
  }
}

console.log(nestedHandlers(0), nestedHandlers(1), nestedHandlers(2));

function throwInsideLoop(limit: number): string {
  try {
    for (let i = 0; i < limit; i++) {
      const perIteration: any = { i, label: "loop-" + i };
      const closure = () => perIteration.label;
      allocateBurst(50);
      if (i === limit - 1) {
        throw { closure, perIteration };
      }
    }
    return "unreachable";
  } catch (error: any) {
    allocateBurst(100);
    return error.closure() + ":" + error.perIteration.i;
  }
}

console.log(throwInsideLoop(6));

// Both functions return numbers but keep reference-like locals live across the
// recursive call. This exercises the i64/f64 specialized emitters' frame paths.
function recurseInteger(depth: number): number {
  const held: any = { value: 1 };
  if (depth === 0) {
    return allocateBurst(500);
  }
  return recurseInteger(depth - 1) + held.value;
}

function recurseFractional(depth: number): number {
  const held: any = { value: 0.5 };
  if (depth === 0) {
    return allocateBurst(500) + 0.25;
  }
  return recurseFractional(depth - 1) + held.value;
}

console.log(recurseInteger(2_500));
console.log(recurseFractional(1_500));

// A wide frame catches initialization/slot-count mistakes and makes both young
// and full scans walk many adjacent roots.
function wideFrame(): string {
  const v0: any = { n: 0 };
  const v1: any = { n: 1 };
  const v2: any = { n: 2 };
  const v3: any = { n: 3 };
  const v4: any = { n: 4 };
  const v5: any = { n: 5 };
  const v6: any = { n: 6 };
  const v7: any = { n: 7 };
  const v8: any = { n: 8 };
  const v9: any = { n: 9 };
  const v10: any = { n: 10 };
  const v11: any = { n: 11 };
  const v12: any = { n: 12 };
  const v13: any = { n: 13 };
  const v14: any = { n: 14 };
  const v15: any = { n: 15 };
  allocateBurst(1_000);
  return [
    v0.n, v1.n, v2.n, v3.n, v4.n, v5.n, v6.n, v7.n,
    v8.n, v9.n, v10.n, v11.n, v12.n, v13.n, v14.n, v15.n,
  ].join(",");
}

console.log(wideFrame());

function throwFromPlainFrame(): never {
  const payload: any = { marker: "async-catch" };
  allocateBurst(200);
  throw payload;
}

async function coroutineCatchFinally(): Promise<string> {
  const before: any = { marker: "before" };
  try {
    const dynamicThrower: any = throwFromPlainFrame;
    dynamicThrower();
    return "unreachable";
  } catch (error: any) {
    const retained: any = { before, error };
    await Promise.resolve(0);
    allocateBurst(200);
    return retained.before.marker + ":" + retained.error.marker;
  } finally {
    await Promise.resolve(0);
    allocateBurst(100);
  }
}

coroutineCatchFinally().then((value) => console.log(value));
