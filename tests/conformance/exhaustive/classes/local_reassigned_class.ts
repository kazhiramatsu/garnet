// A local that came from `new A` and is assigned something else: its class must not be taken for
// every use (`drop_reassigned_classes`). The last allocation's class read a field of an A at B's
// offset, with no error.
interface I {
  v: number;
  s: string;
  m(): string;
}
class A implements I {
  v = 1.5;
  s = "a";
  m(): string {
    return "A.m";
  }
}
class B implements I {
  pad = "pad";
  pad2 = 7;
  s = "b";
  v = 2.5;
  m(): string {
    return "B.m";
  }
}

function fields(): string {
  let x: I = new A();
  const r = x.v;
  const q = x.s;
  x = new B();
  return r + q + x.v + x.s;
}
console.log(fields());

function methods(): string {
  let x: I = new A();
  const r = x.m();
  x = new B();
  return r + x.m();
}
console.log(methods());

function writes(): string {
  let x: I = new B();
  x.v = 3.5;
  x.s = "w";
  const first = x.v + x.s;
  x = new A();
  x.v = 4.5;
  x.s = "z";
  return first + x.v + x.s;
}
console.log(writes());

function pick(flag: boolean): I {
  return flag ? new A() : new B();
}
function fromCall(): string {
  let x: I = new A();
  const r = x.v;
  x = pick(false);
  const q = x.v;
  x = pick(true);
  return r + "," + q + "," + x.v;
}
console.log(fromCall());

function inLoop(): string {
  let x: I = new A();
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(x.s + x.v);
    x = i % 2 === 0 ? new B() : new A();
  }
  return out.join(",");
}
console.log(inLoop());

function branch(c: boolean): string {
  let x: I = new A();
  if (c) x = new B();
  return x.s + x.v;
}
console.log(branch(true), branch(false));

function toPlain(): string {
  let x: I = new A();
  const r = x.v;
  x = { v: 0.5, s: "p", m: () => "plain" };
  x.v = 6.5;
  return r + x.s + x.v + x.m();
}
console.log(toPlain());

function toNull(): string {
  let x: A | null = new A();
  const r = x.v;
  x = null;
  const read = (): number => (x as any).v;
  try {
    return r + "," + read();
  } catch (e) {
    return r + "," + (e as Error).constructor.name;
  }
}
console.log(toNull());

function anyLocal(): string {
  let x: any = new A();
  const r = x.v;
  x = 5;
  const q = x + 1;
  x = "str";
  return r + "," + q + "," + x.length;
}
console.log(anyLocal());

async function viaAwait(): Promise<string> {
  let x: I = new A();
  const r = x.v;
  x = await Promise.resolve(pick(false));
  return r + "," + x.v + x.s;
}
viaAwait().then(console.log);

function* viaYield(): Generator<number, void, I> {
  let x: I = new A();
  yield x.v;
  x = yield 0;
  yield x.v;
}
const g = viaYield();
g.next();
g.next();
console.log(g.next(new B()).value);

function caught(): string {
  let x: I = new A();
  const r = x.v;
  try {
    throw new B();
  } catch (e) {
    x = e as I;
  }
  return r + "," + x.v + x.s;
}
console.log(caught());
