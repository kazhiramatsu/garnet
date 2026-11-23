// A store to a class field through a receiver typed as the class, in a program that freezes instances of it:
// the frozen bit is an instance's, so a receiver that is no instance (undefined, null, a number, a string, a plain
// object, a frozen plain object, an array) must take the generic store, which answers for each as V8 does. The
// functions are called through a value as well: a direct call with a constant receiver folds the test away.
class A {
  x = 1;
  y: A | undefined = undefined;
  n = 0.5;
}
class B extends A {
  z = "b";
}

function setX(a: A): void {
  a.x = 2;
}
function setY(a: A): void {
  a.y = a;
}
function setN(a: A, v: number): void {
  a.n = v;
}
function setZ(b: B): void {
  b.z = "set";
}
function bump(a: A): number {
  a.x = a.x + 1;
  return a.x;
}

function show(label: string, run: () => unknown): void {
  try {
    console.log(label, String(run()));
  } catch (e) {
    console.log(label, "threw", String(e));
  }
}

function main(): void {
  const frozenA = new A();
  Object.freeze(frozenA);
  const frozenB = new B();
  Object.freeze(frozenB);
  const plain: any = { x: 0 };
  const frozenPlain: any = Object.freeze({ x: 0 });
  const receivers: [string, any][] = [
    ["undefined", undefined],
    ["null", null],
    ["number", 5],
    ["string", "s"],
    ["boolean", true],
    ["plain", plain],
    ["frozen plain", frozenPlain],
    ["array", [1, 2]],
    ["instance", new A()],
    ["subclass", new B()],
    ["frozen instance", frozenA],
    ["frozen subclass", frozenB],
  ];
  const direct: [string, (a: any) => unknown][] = [
    ["setX", (a) => setX(a)],
    ["setY", (a) => setY(a)],
    ["setN", (a) => setN(a, 1.25)],
    ["setZ", (a) => setZ(a)],
    ["bump", (a) => bump(a)],
  ];
  const values: any[] = [setX, setY, (a: any) => setN(a, 2.5), setZ, bump];
  for (const [name, r] of receivers) {
    for (const [fname, f] of direct) show(name + " " + fname, () => f(r));
    for (let i = 0; i < values.length; i++) show(name + " value " + i, () => values[i](r));
  }
  console.log(plain.x, plain.y === plain, plain.n, plain.z);
  console.log(frozenPlain.x, Object.keys(frozenPlain).join());
  console.log(frozenA.x, frozenA.y, frozenA.n, frozenB.z);
  const live = receivers[8][1] as A;
  console.log(live.x, live.y === live, live.n);
  const sub = receivers[9][1] as B;
  console.log(sub.x, sub.y === sub, sub.n, sub.z);
}
main();
