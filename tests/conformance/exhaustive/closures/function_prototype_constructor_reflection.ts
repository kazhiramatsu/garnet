function Hoisted(a: any): any {
  return a;
}

function main(): void {
  console.log(Hoisted.prototype.constructor === Hoisted);
  console.log(Object.getOwnPropertyNames(Hoisted.prototype).join(","));

  const hd: any = Object.getOwnPropertyDescriptor(Hoisted.prototype, "constructor");
  console.log(hd.writable, hd.enumerable, hd.configurable, typeof hd.value);

  Hoisted.prototype.extra = 1;
  console.log(Object.getOwnPropertyNames(Hoisted.prototype).join(","));

  const Expr: any = function NamedExpr(): void {};
  console.log(Expr.prototype.constructor === Expr);
  console.log(Object.getOwnPropertyNames(Expr.prototype).join(","));

  Expr.prototype.constructor = 123;
  Expr.prototype.m = function (): number {
    return 7;
  };
  console.log(Expr.prototype.constructor, Expr.prototype.m());
  console.log(Object.getOwnPropertyNames(Expr.prototype).join(","));
}

main();
