// Namespace member functions called directly: sibling calls before and after
// the declaration, recursion, members used as values and callbacks, calls
// through the namespace object from outside, nested and merged namespaces,
// a member reading a namespace `let` that a sibling reassigns, generics.
namespace Parser {
  let current = 0;
  const log: string[] = [];
  export function parse(input: number[]): number {
    current = 0;
    let sum = 0;
    while (current < input.length) { sum += token(input); next(); }
    return sum + depth(3) + applyTwice(double, 5) + Nested.inner(2) + log.length;
  }
  function token(input: number[]): number { return input[current] * weight(); }
  function next(): void { current++; log.push("n" + current); }
  function weight(): number { return current % 2 === 0 ? 1 : 10; }
  function depth(n: number): number { return n === 0 ? 0 : 1 + depth(n - 1); }
  function double(x: number): number { return x * 2; }
  function applyTwice(f: (x: number) => number, x: number): number { return f(f(x)); }
  export function identityOf<T>(x: T): T { return x; }
  export function pick(): (x: number) => number { return double; }
  export namespace Nested {
    export function inner(k: number): number { return helper(k) + current; }
    function helper(k: number): number { return k * 100; }
  }
}
namespace Parser {
  export function extra(): number { return bonus() + 1; }
  function bonus(): number { return 7; }
}
namespace Debug {
  let failures = 0;
  export function assert(cond: boolean, msg: string): void { if (!cond) fail(msg); }
  export function fail(msg: string): never { failures++; throw new Error(msg + "#" + failures); }
  export function count(): number { return failures; }
}
function outside(): string {
  const f = Parser.pick();
  const g = Parser.identityOf<(x: number) => number>(f);
  return [Parser.parse([1, 2, 3, 4]), Parser.parse([5]), Parser.extra(), f(4), g(5), Parser.identityOf("s")].join(",");
}
function main(): void {
  console.log(outside());
  Debug.assert(true, "ok");
  try { Debug.assert(false, "bad"); } catch (e) { console.log(String(e)); }
  try { Debug.fail("again"); } catch (e) { console.log(String(e)); }
  console.log(Debug.count());
  const callbacks: Array<(x: number) => number> = [Parser.pick(), (x) => x + 1];
  console.log(callbacks.map((c) => c(10)).join("/"));
}
main();
