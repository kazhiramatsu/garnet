// A value typed as an array that is none at run time takes the method it has, or fails as the call would.
function typed(x: number[]): any[] {
  const out: any[] = [];
  const tryit = (f: () => any) => { try { out.push(f()); } catch (e: any) { out.push(e.name); } };
  tryit(() => x.map((v) => v + 1));
  tryit(() => x.filter((v) => v > 0));
  tryit(() => x.push(1));
  tryit(() => x.pop());
  tryit(() => x.indexOf(1));
  tryit(() => x.join("-"));
  tryit(() => x[0]);
  tryit(() => x.slice(1));
  tryit(() => x.concat([1]));
  tryit(() => { x[1] = 5; return (x as any)[1]; });
  tryit(() => x.sort());
  tryit(() => x.reverse());
  tryit(() => x.includes(1));
  return out;
}
console.log(typed({ 0: 1, length: 1 } as any));
console.log(typed("abc" as any));
console.log(typed(new Map([[1, 2]]) as any));
console.log(typed(new Set([1, 2]) as any));
console.log(typed(new Int8Array([1, 2, 3]) as any));
class Li { items = [3, 1]; map(f: any) { return this.items.map(f); } push(x: number) { this.items.push(x); return 99; } get length() { return 7; } }
console.log(typed(new Li() as any));
