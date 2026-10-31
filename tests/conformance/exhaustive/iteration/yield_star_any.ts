// `yield*` over a value of no known type: GetIterator at run time, the values passed through, the sent
// values, the delegate's result, a throw and a return forwarded.
function* over(v: any): Generator<any, any, any> {
  const r = yield* v;
  yield "result " + r;
}
function* inner(): Generator<number, string, number> {
  const a = yield 1;
  const b = yield a + 1;
  return "done" + b;
}
console.log([...over([1, 2])].join(), [...over("xy")].join(), [...over(new Set([3]))].join(), [...over(new Map([[1, 2]]))].join());
const g = over(inner());
console.log(g.next().value, g.next(10).value, g.next(20).value, g.next().done);
const custom: any = {
  n: 0,
  [Symbol.iterator]() {
    return this;
  },
  next(v: any) {
    this.n++;
    return this.n > 2 ? { done: true, value: "end" + v } : { done: false, value: this.n };
  },
  return(v: any) {
    console.log("return");
    return { done: true, value: v };
  },
  throw(e: any) {
    console.log("throw", e);
    return { done: true, value: "caught" };
  },
};
console.log([...over(custom)].join());
custom.n = 0;
const t = over(custom);
t.next();
console.log(t.throw("boom").value);
custom.n = 0;
const r = over(custom);
r.next();
console.log(r.return("early").value, r.next().done);
try {
  [...over(5)];
} catch (e) {
  console.log((e as Error).constructor.name);
}
async function* aover(v: any): AsyncGenerator<any> {
  yield* v;
}
async function run(): Promise<void> {
  const out: any[] = [];
  for await (const x of aover([1, 2])) out.push(x);
  async function* src(): AsyncGenerator<number> {
    yield 3;
  }
  for await (const x of aover(src())) out.push(x);
  console.log(out.join());
}
run();
