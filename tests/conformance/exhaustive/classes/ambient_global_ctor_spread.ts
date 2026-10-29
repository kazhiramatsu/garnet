// `new X(...args)` where X is a constructor the environment declares (lib.dom) but the engine
// does not provide, with spread arguments (hono's client: `new WebSocket(...args)`): the
// arguments are gathered into an array and the global's value constructed over it, so the program
// compiles and the construct is a ReferenceError where it is reached (as the positional form is,
// classes/ambient_global_ctor_runtime.ts). Worker and Notification are absent from Node too.
function make(kind: number, args: [string, { name?: string; tag?: string }?]): unknown {
  if (kind === 1) return new Worker(...args);
  if (kind === 2) return new Notification(...args);
  if (kind === 3) return new Notification("lead", ...args.slice(1) as [{ name?: string; tag?: string }?]);
  return "no construct";
}
function main(): void {
  console.log(make(0, ["x"]));
  for (const k of [1, 2, 3]) {
    try { console.log(make(k, ["w.js", { name: "n" }])); } catch (e) { console.log("kind", k, e instanceof ReferenceError, (e as Error).message); }
  }
}
main();
