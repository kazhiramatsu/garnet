function main(): void {
  const r = /ab+/gi;
  const same: any = RegExp(r);
  console.log(same === r, same.source, same.flags, same.lastIndex);

  const sameUndef: any = RegExp(r, undefined);
  console.log(sameUndef === r);

  const copy: any = new RegExp(r);
  console.log(copy === r, copy.source, copy.flags, copy.test("ABBB"), copy.lastIndex, r.lastIndex);

  const override: any = new RegExp(r, "g");
  console.log(override.flags, override.test("AB"), override.test("ab"));

  const made = new RegExp("x+", "i");
  const copy2: any = new RegExp(made, "g");
  console.log(copy2.source, copy2.flags, copy2.test("XX"), copy2.test("xx"));

  const direct: any = new RegExp(/a(b)/d);
  const m: any = direct.exec("xab");
  console.log(m[0], m[1], m.indices[1][0], m.indices[1][1]);
}
main();
