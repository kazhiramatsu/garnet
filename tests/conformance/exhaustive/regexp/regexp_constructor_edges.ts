function main(): void {
  const r1: any = RegExp(undefined as any);
  console.log(String(r1), r1.source, r1.flags, r1.test(""));

  const r2: any = new RegExp("ab+", undefined as any);
  console.log(String(r2), r2.source, r2.flags, r2.test("zabb"));

  const r3: any = new RegExp(undefined as any, "g");
  const m: any = "ab".match(r3);
  console.log(String(r3), r3.source, r3.flags, m.length);

  try {
    const bad: any = new RegExp("(");
    console.log("bad", bad.source);
  } catch (e: any) {
    console.log(e.name + ":" + typeof e.message);
  }
}
main();
