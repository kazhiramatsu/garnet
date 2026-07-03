// A Promise's `.then` / `.catch` / `.finally` are first-class method VALUES:
// `typeof p.then === "function"` (not undefined), and the unbound method works
// when invoked with the promise as the receiver (`p.then.call(p, cb)`). This is
// distinct from the common `p.then(cb)` CALL form, which still resolves directly.
// `ts_get` on a promise resolves these via the shared Promise.prototype.

async function asyncOne(): Promise<number> {
  return 1;
}

async function main(): Promise<void> {
  const p = Promise.resolve(10);

  // value access -> a function
  console.log(typeof p.then); // function
  console.log(typeof p.catch); // function
  console.log(typeof p.finally); // function

  // various promise-typed receivers
  console.log(typeof Promise.resolve(1).then); // function
  console.log(typeof asyncOne().then); // function

  // stored as a value, then typeof
  const f = p.then;
  console.log(typeof f); // function

  // the unbound method invoked with an explicit receiver actually works
  const doubled = await p.then.call(p, (v: number) => v * 2);
  console.log(doubled); // 20

  // regression: the ordinary call form / await / combinators still work
  const a = await Promise.resolve(3).then((v) => v + 1);
  console.log(a); // 4

  let trace = "";
  await Promise.reject(new Error("boom"))
    .catch(() => {
      trace += "c";
    })
    .finally(() => {
      trace += "f";
    });
  console.log(trace); // cf

  const all = await Promise.all([Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]);
  console.log(all.join(",")); // 1,2,3

  const v = await asyncOne();
  console.log(v); // 1
}

main();
