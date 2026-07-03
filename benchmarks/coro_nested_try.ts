async function ok(): Promise<number> { return 5; }
async function bad(): Promise<number> { throw "inner-fail"; }
async function main(): Promise<void> {
  // nested try: inner catches, outer doesn't fire
  try {
    const a = await ok();
    try {
      const b = await bad();      // rejects
      console.log("unreachable " + b);
    } catch (e) {
      console.log("inner: " + e); // inner: inner-fail
    }
    console.log("after inner: " + a);  // after inner: 5
  } catch (e) {
    console.log("outer: " + e);
  }
  console.log("---");
  // inner catch re-throws -> outer catches
  try {
    const a = await ok();
    try {
      const b = await bad();
      console.log("unreachable " + b);
    } catch (e) {
      console.log("inner caught, rethrowing");  // printed
      throw "outer-fail";          // re-throw to outer
    }
  } catch (e) {
    console.log("outer: " + e);    // outer: outer-fail
  }
  console.log("done");
}

main();
