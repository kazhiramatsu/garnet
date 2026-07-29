function recurseWithLiveObjects(depth: number): number {
  const guard: any = { value: 1 };
  if (depth === 0) {
    let checksum = 0;
    for (let i = 0; i < 2_000; i++) {
      const temporary: any = { value: i };
      checksum += temporary.value;
    }
    return checksum;
  }
  return recurseWithLiveObjects(depth - 1) + guard.value;
}

function wrapThrower(next: any, index: number): any {
  const captured: any = { index };
  return () => {
    const local: any = { index: captured.index };
    if (local.index < 0) {
      return "unreachable";
    }
    return next();
  };
}

let thrower: any = () => {
  const payload: any = { marker: "five-frames" };
  throw payload;
};
for (let i = 0; i < 5; i++) {
  thrower = wrapThrower(thrower, i);
}

console.log(recurseWithLiveObjects(1_500));
try {
  thrower();
} catch (error: any) {
  console.log(error.marker);
}

function throwFromPlainFrame(): never {
  const payload: any = { marker: "mixed-coro" };
  throw payload;
}

async function catchInCoroutine(): Promise<string> {
  const dynamicThrower: any = throwFromPlainFrame;
  try {
    dynamicThrower();
    return "unreachable";
  } catch (error: any) {
    const held: any = { error };
    await Promise.resolve(0);
    return held.error.marker;
  }
}

catchInCoroutine().then((value) => console.log(value));
