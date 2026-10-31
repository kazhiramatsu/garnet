// Unbounded recursion is a RangeError a `try` catches, again and again, and the program goes on; what it
// printed before stays. The depth differs from V8's, the error does not. (Each function stores after its
// call: a recursion the C compiler can turn into a loop has no stack to overflow, and spins.)
let sink = 0;
function deep(n: number): number {
  const r = deep(n + 1) + 1;
  sink = r;
  return r;
}
function attempt(f: () => unknown): string {
  try {
    f();
    return "no throw";
  } catch (e) {
    return (e as Error).constructor.name + ": " + (e as Error).message + " " + (e instanceof RangeError);
  }
}
console.log("before");
console.log(attempt(() => deep(0)));
console.log(attempt(() => deep(0)));
class Walker {
  n = 0;
  walk(): number {
    this.n++;
    const r = this.walk() + 1;
    this.n = r;
    return r;
  }
}
const w = new Walker();
console.log(attempt(() => w.walk()), w.n > 100);
const ping = (n: number): number => {
  const r = pong(n + 1) + 1;
  sink = r;
  return r;
};
const pong = (n: number): number => {
  const r = ping(n + 1) + 1;
  sink = r;
  return r;
};
console.log(attempt(() => ping(0)));
function finallyRuns(): string {
  const log: string[] = [];
  try {
    try {
      deep(0);
    } finally {
      log.push("finally");
    }
  } catch (e) {
    log.push((e as Error).name);
  }
  return log.join();
}
console.log(finallyRuns());
const s: string[] = [];
for (let i = 0; i < 1000; i++) s.push("x" + i);
console.log(s.length, s[999], JSON.stringify({ a: [1, 2] }));
async function later(): Promise<string> {
  try {
    deep(0);
  } catch (e) {
    return "async " + (e as Error).name;
  }
  return "none";
}
later().then(console.log);
