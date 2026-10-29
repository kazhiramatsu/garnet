// `import(spec)` of a module the program does not bundle, the specifier a const of a literal type
// (hono's color helper probes `cloudflare:workers` behind a runtime check, inside a try/catch): the
// promise rejects with an Error naming the module, as Node rejects a module it cannot load, so the
// catch runs and the program goes on. (A literal specifier of a bundled module stays a compile-time
// reject: tests/conformance/rejects/dynamic_import.ts.)
async function main(): Promise<void> {
  const spec = "cloudflare:workers";
  try {
    const m = await import(spec);
    console.log("loaded", typeof m);
  } catch (e) {
    console.log("rejected", e instanceof Error, typeof (e as Error).message);
  }
  const noColor = await (async () => {
    try {
      return "NO_COLOR" in ((await import(spec)).env ?? {});
    } catch {
      return false;
    }
  })();
  console.log("noColor", noColor);
  const p = import(spec);
  console.log("pending promise", p instanceof Promise);
  await p.then(() => console.log("not here"), (e: unknown) => console.log("then-rejected", e instanceof Error));
}
main();
