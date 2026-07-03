// End-to-end sample for the escape analyzer.
// Each `const X = {}` / `[]` is an allocation site labelled `X@<func>`.

let sink: any; // module-level variable == the global sink

export function makeEscaping() {
  const o = {};
  return o; // exported + returned  -> GlobalEscape
}

function keepsLocal() {
  const o: any = {};
  o.k = 1; // store a primitive into a field; o never leaves
  return undefined; // NoEscape
}

function leaks() {
  const o = {};
  sink = o; // stored into the global -> GlobalEscape
}

function id(x: any) {
  return x; // summary: param0 -> return, no global leak
}

function passAndDrop() {
  const o = {};
  id(o); // passed to id, result dropped -> NoEscape
}

function passAndLeak() {
  const o = {};
  sink = id(o); // id returns the arg, which is then leaked -> GlobalEscape
}

function holdsThenReturns() {
  const inner = {};
  const outer: any = {};
  outer.c = inner; // outer.c = inner
  return outer; // outer -> ArgEscape; inner reachable via outer.c -> ArgEscape
}
