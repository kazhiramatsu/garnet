// GetIterator and for-await: the methods the protocol reads, whatever the static type says. An
// IterableIterator goes through [Symbol.iterator]; a union with a generator takes the value as it is; an
// object with `next` alone is not iterable; a subclass's `return` closes a loop over the base type; a
// for-await over a sync iterator awaits the values; generator steps shared by two loops across awaits.
const o3: any = {
  next() {
    return { done: true, value: 0 };
  },
  [Symbol.iterator]() {
    return [7].values();
  },
};
for (const x of o3 as IterableIterator<number>) console.log(x);

const o4: any = {
  next() {
    return { done: false, value: 1 };
  },
};
try {
  const [x4] = o4 as Iterable<number>;
  console.log(x4);
} catch (e) {
  console.log((e as Error).constructor.name);
}
try {
  for (const x of o4 as Iterable<number>) {
    console.log(x);
    break;
  }
} catch (e) {
  console.log((e as Error).constructor.name);
}

function* g8(): Generator<number> {
  yield 1;
}
function f8(v: Generator<number> | number[]): number[] {
  const out: number[] = [];
  for (const x of v) out.push(x);
  return out;
}
console.log(f8([2]), f8(g8()));

class B10 {
  next(): IteratorResult<number> {
    return { done: false, value: 1 };
  }
  [Symbol.iterator](): B10 {
    return this;
  }
}
class D10 extends B10 {
  log: string[] = [];
  return(): any {
    this.log.push("return");
    return { done: true, value: 0 };
  }
}
const d10 = new D10();
const b10: B10 = d10;
for (const x of b10) break;
console.log(d10.log.join(","));

async function f6(v: Iterable<Promise<number>>): Promise<void> {
  for await (const x of v) console.log(x);
}
async function arrayOfPromises(): Promise<void> {
  const ps: Promise<number>[] = [Promise.resolve(2), Promise.resolve(3)];
  for await (const x of ps) console.log(x);
  const mixed: (number | Promise<number>)[] = [4, Promise.resolve(5)];
  for await (const x of mixed) console.log(x);
}
function* gp(): Generator<Promise<number>> {
  yield Promise.resolve(6);
}
async function genOfPromises(): Promise<void> {
  for await (const x of gp()) console.log(x);
}
class Sync7 {
  [Symbol.iterator](): IterableIterator<Promise<number>> {
    return [Promise.resolve(7)].values();
  }
}
async function classOfPromises(): Promise<void> {
  for await (const x of new Sync7()) console.log(x);
}
async function asyncSource(): Promise<void> {
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        next(): Promise<IteratorResult<number>> {
          return Promise.resolve(n++ < 1 ? { done: false, value: 8 } : { done: true, value: 0 });
        },
      };
    },
  };
  for await (const x of source) console.log(x);
}
function* g12(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
  yield 4;
}
async function d12(n: string, it: any, out: string[]): Promise<void> {
  for await (const x of it as AsyncIterable<number>) out.push(n + x);
}
async function m12(): Promise<void> {
  const out: string[] = [];
  const s = g12();
  await Promise.all([d12("a", s, out), d12("b", s, out)]);
  console.log(out.join(","));
}
async function d13(n: string, s: Generator<number>, out: string[]): Promise<void> {
  for await (const x of s) out.push(n + x);
}
async function m13(): Promise<void> {
  const out: string[] = [];
  const s = g12();
  await Promise.all([d13("a", s, out), d13("b", s, out)]);
  console.log(out.join(","));
}
async function main(): Promise<void> {
  await f6([Promise.resolve(1)]);
  await arrayOfPromises();
  await genOfPromises();
  await classOfPromises();
  await asyncSource();
  await m12();
  await m13();
}
main();
