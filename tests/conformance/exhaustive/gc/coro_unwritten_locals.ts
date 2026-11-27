// A local of an async function or of a generator read before anything was written to it, across an
// await or a yield. Its frame field starts as zeroed memory (docs/unmasked_pointers_design.md, section 7),
// which must read as undefined, as in V8: not as the number 0, nor (representation 1) as a reference.
async function tick(): Promise<void> {}
async function f(flag: boolean): Promise<string> {
  if (flag) { var early: any = "set"; }
  await tick();
  const seen = typeof early + ":" + String(early);
  var late: any;
  await tick();
  return seen + "|" + typeof late + ":" + String(late);
}
function* g(flag: boolean): Generator<string> {
  if (flag) { var v: any = 1; }
  yield typeof v;
  yield String(v);
}
async function main(): Promise<void> {
  console.log(await f(false), await f(true));
  console.log([...g(false)].join(","), [...g(true)].join(","));
}
main();
