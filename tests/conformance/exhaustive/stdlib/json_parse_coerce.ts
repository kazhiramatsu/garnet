// JSON.parse coerces its argument ToString first (JSON.parse(5) === 5), and an
// argument that stringifies to invalid JSON throws a catchable SyntaxError.
function main(): void {
  console.log(JSON.parse(5 as any), JSON.parse("5"), JSON.parse(true as any), JSON.parse(null as any));
  console.log(JSON.parse(3.14 as any), JSON.parse(-7 as any));
  for (const bad of [{} as any, undefined as any, "{nope" as any]) {
    try { JSON.parse(bad); console.log("no-throw"); }
    catch (e) { console.log(e instanceof SyntaxError, e instanceof Error); }
  }
}
main();
