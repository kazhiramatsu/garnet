// Promise.resolve / Promise.reject with await (the other Promise statics and
// .then are not yet implemented and loud-reject).
async function userAsync(): Promise<number> {
  return 10;
}

async function main(): Promise<void> {
  const x = await Promise.resolve(42);
  console.log(x);                                 // 42

  const a = await Promise.resolve(1);
  const b = await Promise.resolve(a + 1);
  console.log(b);                                 // 2

  try {
    await Promise.reject(new Error("boom"));
  } catch (e: any) {
    console.log(e.message);                        // boom
  }

  console.log(await userAsync());                  // 10

  const o = await Promise.resolve({ v: 5 });
  console.log(o.v);                                // 5
}

main();
