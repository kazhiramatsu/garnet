// Demonstrates all four allocation tiers.
let sink: any;

function stackOne() {
  const p = { x: 1 }; // no-escape, determinable, once -> stack
  p.x = 2;
}
function arenaLoop() {
  let total = { n: 0 };          // once, no-escape, determinable -> stack
  for (let i = 0; i < 10; i = i + 1) {
    const tmp = { a: 1 };        // no-escape but MANY (loop) -> frameArena
    total.n = total.n + tmp.a;
  }
}
function indexedArena() {
  const m: { [k: string]: number } = {}; // index signature -> not determinable -> frameArena
  m["a"] = 1;
}
function escapesArg() {
  const o = { v: 1 };
  return o; // arg-escape -> callerArena
}
function escapesGlobal() {
  const g = { v: 1 };
  sink = g; // global-escape -> heap
}
