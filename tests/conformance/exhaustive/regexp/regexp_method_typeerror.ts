function main(): void {
  const r = /a/;
  const test: any = r.test;
  try {
    console.log(test("a"));
  } catch (e: any) {
    console.log(e.name + ":" + typeof e.message);
  }

  const exec: any = r.exec;
  try {
    console.log(exec("a"));
  } catch (e: any) {
    console.log(e.name + ":" + typeof e.message);
  }
}
main();
