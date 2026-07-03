// Async methods (`async [mySym]()`) and async-generator methods
// (`async *[mySym]()`) keyed by a user symbol, both instance and static. Like
// plain symbol methods (and the sync generators in classes/dynkey_generator_method),
// the state machine is boxed as a ts_func value and installed under the symbol
// key; awaiting / for-await over it drives the coroutine. A `unique symbol` key
// types the access so `await x[s]()` and `for await (... of x[s]())` resolve.

const am: unique symbol = Symbol("am");
const ag: unique symbol = Symbol("ag");
const sm: unique symbol = Symbol("sm");
const sg: unique symbol = Symbol("sg");

class Svc {
  base = 40;
  // instance async method capturing `this`.
  async [am](): Promise<number> {
    const bump = await Promise.resolve(2);
    return this.base + bump;
  }
  // instance async generator capturing `this`.
  async *[ag](): AsyncGenerator<number> {
    yield this.base;
    yield await Promise.resolve(this.base + 1);
  }
  // static async method (`this` = class).
  static tag = 7;
  static async [sm](): Promise<number> {
    return Svc.tag * 10;
  }
  // static async generator.
  static async *[sg](): AsyncGenerator<number> {
    yield 1;
    yield 2;
    yield 3;
  }
}

async function main(): Promise<void> {
  const s = new Svc();

  // instance async method
  console.log(await s[am]()); // 42

  // static async method
  console.log(await Svc[sm]()); // 70

  // instance async generator via for-await (captures this.base)
  let it = 0;
  for await (const x of s[ag]()) it += x;
  console.log(it); // 81

  // static async generator via for-await
  let st = 0;
  for await (const x of Svc[sg]()) st += x;
  console.log(st); // 6
}

main();
