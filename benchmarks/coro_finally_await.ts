async function bad(): Promise<number> { throw "oops"; }
async function cleanup(): Promise<number> { return 7; }
async function inner(): Promise<void> {
  try {
    const r = await bad();   // throws
    console.log("unreachable " + r);
  } finally {
    const c = await cleanup();   // finally runs (suspends), then exception propagates
    console.log("cleanup ran: " + c);   // cleanup ran: 7
  }
}
async function main(): Promise<void> {
  try {
    await inner();    // inner's finally runs, then "oops" propagates here
  } catch (e) {
    console.log("outer caught: " + e);  // outer caught: oops
  }
  console.log("done");
}

main();
