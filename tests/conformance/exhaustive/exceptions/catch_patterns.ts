// @ts-nocheck
// A destructuring catch parameter, and names no declaration binds (a JavaScript file's ReferenceError).
function attempt(f: () => unknown): string {
  try {
    return String(f());
  } catch (e) {
    return (e as Error).constructor.name;
  }
}
try {
  throw { code: 7, inner: [1, 2] };
} catch ({ code, inner: [a, b] }) {
  console.log(code, a, b);
}
try {
  throw [1, 2, 3];
} catch ([x, ...rest]) {
  console.log(x, rest);
}
const fs: (() => number)[] = [];
for (let i = 0; i < 2; i++) {
  try {
    throw { v: i };
  } catch ({ v }) {
    fs.push(() => v);
  }
}
console.log(fs.map((f) => f()));
const gs: (() => number)[] = [];
for (let i = 0; i < 2; i++) {
  try {
    throw i;
  } catch (e) {
    gs.push(() => e);
  }
}
console.log(gs.map((f) => f()));
console.log(attempt(() => { try { throw null; } catch ({}) { return "no"; } }));
console.log(attempt(() => { try { throw 1; } catch ({ a = 5 }) { return a; } }));
console.log(attempt(() => { const {} = null as any; return "no"; }), attempt(() => { const {} = 1 as any; return "yes"; }));
