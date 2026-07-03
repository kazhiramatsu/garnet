async function ok(): Promise<number> { return 10; }
async function bad(): Promise<number> { throw "rejected!"; }
async function main(): Promise<void> {
  // try/await success path
  try {
    const r = await ok();
    console.log(r);              // 10
  } catch (e) {
    console.log("caught: " + e);
  }
  // try/await with a rejected promise -> catch
  try {
    const r = await bad();
    console.log("unreachable " + r);
  } catch (e) {
    console.log("caught: " + e); // caught: rejected!
  }
  console.log("done");           // done
}

main();
