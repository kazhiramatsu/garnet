// Promise.all / Promise.race.
async function producer(n: number): Promise<number> { return n; }

async function main(): Promise<void> {
  // all: resolves to an array in input order; non-promises pass through.
  const r = await Promise.all([Promise.resolve(1), Promise.resolve(2), 3]);
  console.log(r.join(","));                     // 1,2,3

  // empty array -> [].
  console.log((await Promise.all([])).length);  // 0

  // order preserved with async producers.
  const o = await Promise.all([producer(1), producer(2), producer(3)]);
  console.log(o.join(","));                      // 1,2,3

  // all of a mapped async -> reduce.
  const sums = await Promise.all([1, 2, 3].map(async (x) => x * 10));
  console.log(sums.reduce((a, b) => a + b, 0));  // 60

  // all rejects with the first rejection reason.
  try {
    await Promise.all([Promise.resolve(1), Promise.reject(new Error("boom"))]);
  } catch (e: any) {
    console.log("all-rej:" + e.message);          // all-rej:boom
  }

  // race: settles with the first input.
  console.log(await Promise.race([Promise.resolve("a"), Promise.resolve("b")])); // a

  // race rejecting.
  try {
    await Promise.race([Promise.reject(new Error("r")), Promise.resolve(1)]);
  } catch (e: any) {
    console.log("race-rej:" + e.message);         // race-rej:r
  }

  // many concurrent Promise.all (exercises GC under allocation pressure).
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const arr: Promise<number>[] = [];
    for (let j = 0; j < 10; j++) arr.push(Promise.resolve(j));
    total += (await Promise.all(arr)).reduce((a, b) => a + b, 0);
  }
  console.log(total);                            // 1350 (45 * 30)
}

main();
