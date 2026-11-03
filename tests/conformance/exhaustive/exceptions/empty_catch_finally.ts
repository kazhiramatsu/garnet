// A catch clause with no binding and an empty block swallows the exception: with a finally it went on past it (silent to the
// `try` itself: the exception came out of the statement, and the code after it never ran).
function plain(p: number): number {
  try { throw new Error("a"); } catch { } finally { p += 1; }
  return p + 10;
}
console.log(plain(1));
function nested(p: number): number {
  try { throw new Error("a"); } catch {
    try { throw new Error("b"); } catch { } finally { const a = [p]; p += a.length; }
  }
  return p;
}
console.log(nested(1));
function bound(p: number): number {
  try { throw new Error("a"); } catch (e) { } finally { p += 1; }
  return p;
}
console.log(bound(1));
function noCatch(p: number): string {
  try {
    try { throw new Error("a"); } finally { p += 1; }
  } catch (e: any) { return e.message + p; }
}
console.log(noCatch(1));
function returns(p: number): number {
  try { throw new Error("a"); } catch { } finally { if (p > 0) return 7; }
  return 8;
}
console.log(returns(1), returns(0));
function loop(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try { if (i % 2) throw new Error("odd"); s += 1; } catch { } finally { s += 10; }
  }
  return s;
}
console.log(loop(5));
function* gen(): Generator<number> {
  try { throw new Error("a"); } catch { } finally { yield 1; }
  yield 2;
}
console.log([...gen()]);
async function coro(): Promise<number> {
  try { await Promise.reject(new Error("a")); } catch { } finally { await null; }
  return 3;
}
coro().then((v) => console.log(v));
