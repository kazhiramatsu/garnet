// Promise instance methods (.then/.catch/.finally) and statics allSettled/any.
async function main(): Promise<void> {
  // .then: transform; chain; return-a-promise adoption.
  console.log(await Promise.resolve(1).then((v) => v + 1));            // 2
  console.log(await Promise.resolve(2).then((v) => v * 3).then((v) => v + 1)); // 7
  console.log(await Promise.resolve(5).then((v) => Promise.resolve(v * 2)));   // 10

  // .then with a throwing callback -> the result promise rejects -> .catch.
  console.log(await Promise.resolve(1).then(() => { throw new Error("boom"); }).catch((e: any) => "caught:" + e.message)); // caught:boom

  // .catch: handles rejection; skipped on fulfillment.
  console.log(await Promise.reject(new Error("x")).catch((e: any) => "c:" + e.message)); // c:x
  console.log(await Promise.resolve(7).catch(() => 0));               // 7

  // .then(onFulfilled, onRejected): the second handler runs on rejection.
  console.log(await Promise.reject(3).then((v) => "f" + v, (r) => "r" + r)); // r3

  // .finally: runs on both paths; the original value/reason passes through.
  let log = "";
  console.log(await Promise.resolve(9).finally(() => { log += "f"; }), log); // 9 f
  try {
    await Promise.reject(new Error("r")).finally(() => { log += "g"; });
  } catch (e: any) {
    console.log(log, e.message);                                      // fg r
  }

  // allSettled: never rejects; reports per-input status.
  const s = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("x"))]);
  console.log(s[0].status, (s[0] as any).value, s[1].status, ((s[1] as any).reason as Error).message); // fulfilled 1 rejected x
  console.log((await Promise.allSettled([])).length);                 // 0

  // any: first fulfilled; all-reject -> AggregateError.
  console.log(await Promise.any([Promise.reject(new Error("a")), Promise.resolve(2)])); // 2
  try {
    await Promise.any([Promise.reject(new Error("a")), Promise.reject(new Error("b"))]);
  } catch (e: any) {
    console.log(e.name, e.message, e.errors.length);                  // AggregateError All promises were rejected 2
  }
}

main();
