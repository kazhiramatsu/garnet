async function log2(s: string): Promise<void> { console.log(s); }
async function f(): Promise<string> {
  try {
    try {
      return "deep";        // return through inner+outer finally
    } finally {
      await log2("inner-fin");
    }
  } finally {
    await log2("outer-fin");
  }
}
async function main(): Promise<void> {
  const r = await f();
  console.log(r);   // inner-fin, outer-fin, deep
}

main();
