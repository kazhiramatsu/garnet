async function cleanup(): Promise<void> { console.log("cleanup"); }
async function f(): Promise<number> {
  try {
    return 42;            // return through finally (which awaits)
  } finally {
    await cleanup();
  }
}
async function main(): Promise<void> {
  const r = await f();
  console.log(r);   // cleanup, then 42
}

main();
