function Plain(a: any, b: any): void {
  void a;
  void b;
}

function readsPlainValue(): boolean {
  const F: any = Plain;
  return Plain === Plain && F === Plain && F.prototype === Plain.prototype;
}

function main(): void {
  const F: any = Plain;
  console.log(Plain === Plain, F === Plain, Object.hasOwn(Plain, "prototype"));

  const d = Object.getOwnPropertyDescriptor(Plain, "prototype");
  console.log(typeof Plain.prototype, d.value === Plain.prototype, d.writable, d.enumerable, d.configurable);
  console.log(Object.getOwnPropertyNames(Plain).join(","));

  Plain.prototype = { x: 1 };
  console.log((Plain.prototype as any).x, Object.getOwnPropertyDescriptor(Plain, "prototype").value === Plain.prototype);

  (Plain as any).extra = 2;
  console.log(Object.getOwnPropertyNames(Plain).join(","));

  const Expr: any = function NamedExpr(x: any): any {
    return x;
  };
  console.log(Expr.name, Expr.length, Object.hasOwn(Expr, "prototype"));
  Expr.prototype = { y: 7 };
  console.log((Expr.prototype as any).y, Object.getOwnPropertyNames(Expr).join(","));

  const Arrow: any = (x: any) => x;
  console.log(Arrow.name, Arrow.length, Object.hasOwn(Arrow, "prototype"));
  console.log(Object.getOwnPropertyNames(Arrow).join(","));

  console.log(readsPlainValue());
}

main();
