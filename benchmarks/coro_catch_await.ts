async function ok(): Promise<number> { return 5; }
async function bad(): Promise<number> { throw "fail"; }
async function recover(): Promise<number> { return 99; }
async function main(): Promise<void> {
  try {
    const r = await bad();        // rejects -> catch
    console.log("unreachable " + r);
  } catch (e) {
    console.log("caught: " + e);  // caught: fail
    const fallback = await recover();  // SUSPENSION INSIDE CATCH
    console.log("fallback: " + fallback);  // fallback: 99
  }
  console.log("done");
}

main();
