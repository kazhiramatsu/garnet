// `new X(...)` where X is a constructor the environment declares (lib.dom) but the engine does not
// provide: the construct is a ReferenceError where it is reached, not a compile-time reject, so a
// program whose such path is never taken compiles (hono's streaming renderer and WebSocket client).
// XMLHttpRequest and DOMParser are typed by lib.dom and absent from Node too.
function make(kind: number): unknown {
  if (kind === 1) return new XMLHttpRequest();
  if (kind === 2) return new DOMParser();
  return "no construct";
}
function main(): void {
  console.log(make(0));
  for (const k of [1, 2]) {
    try { console.log(make(k)); } catch (e) { console.log("kind", k, e instanceof ReferenceError, e instanceof Error); }
  }
}
main();
