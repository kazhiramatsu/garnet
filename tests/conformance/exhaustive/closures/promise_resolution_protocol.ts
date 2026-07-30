// Promise resolution procedure: thenable assimilation, settle-once locking,
// chaining cycles, finally adoption, and abrupt combinator input handling.
async function main(): Promise<void> {
  const same = Promise.resolve(1);
  console.log(Promise.resolve(same) === same); // true

  let release: (value: number) => void;
  const inner = new Promise<number>((resolve) => { release = resolve; });
  const locked = new Promise<number>((resolve, reject) => {
    resolve(inner as any);
    reject("late");
  });
  release!(42);
  console.log(await locked); // 42

  const thenable: any = {
    then(resolve: (value: number) => void, reject: (reason: string) => void): void {
      resolve(7);
      reject("late");
      resolve(8);
    },
  };
  console.log(await Promise.resolve(thenable)); // 7

  const throwingThen: any = {};
  Object.defineProperty(throwingThen, "then", {
    get(): any { throw new Error("getter"); },
  });
  try {
    await Promise.resolve(throwingThen);
  } catch (e: any) {
    console.log(e.message); // getter
  }

  let cycle: Promise<any>;
  cycle = Promise.resolve(1).then(() => cycle);
  try {
    await cycle;
  } catch (e: any) {
    console.log(e instanceof TypeError); // true
  }

  console.log(await Promise.resolve(3).finally(() => Promise.resolve(0))); // 3
  try {
    await Promise.resolve(4).finally(() => Promise.reject("cleanup"));
  } catch (e: any) {
    console.log(e); // cleanup
  }

  try {
    await Promise.all(undefined as any);
  } catch (e: any) {
    console.log(e instanceof TypeError); // true
  }

  const iteratorOnly: any = {
    next(): any { return { value: 1, done: true }; },
  };
  try {
    await Promise.all(iteratorOnly);
  } catch (e: any) {
    console.log(e instanceof TypeError); // true
  }

  const throwingIterable: any = {
    [Symbol.iterator](): any { throw new Error("iterate"); },
  };
  try {
    await Promise.all(throwingIterable);
  } catch (e: any) {
    console.log(e.message); // iterate
  }
}

main();
