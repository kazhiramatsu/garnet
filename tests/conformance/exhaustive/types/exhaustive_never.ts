type Op = { t: "add"; a: number; b: number } | { t: "neg"; a: number } | { t: "lit"; v: number };
function assertNever(x: never): never { throw new Error("unexpected: " + JSON.stringify(x)); }
function evalOp(o: Op): number {
  switch (o.t) {
    case "add": return o.a + o.b;
    case "neg": return -o.a;
    case "lit": return o.v;
    default: return assertNever(o);
  }
}
function main(): void {
  console.log(evalOp({ t: "add", a: 3, b: 4 }));   // 7
  console.log(evalOp({ t: "neg", a: 5 }));         // -5
  console.log(evalOp({ t: "lit", v: 9 }));         // 9
}
main();
