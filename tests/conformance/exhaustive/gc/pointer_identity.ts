// Pointer-stable old generation: a reference to an old cell may be a handle
// (made before the cell was promoted) or a direct pointer (made after), so
// identity must not depend on the bit pattern. This fixture keeps objects
// alive across many promotions and then compares them every way the runtime
// decides identity: `===`, Object.is, switch cases, Map/Set/WeakMap keys,
// indexOf/includes, instanceof and prototype chains, for class instances and
// plain-function instances alike.

class LNode { constructor(public id: number, public next: LNode | null) {} }
function Plain(this: any, v: number) { this.v = v; }
function main() {
  const keep: LNode[] = []; const map = new Map<LNode, number>(); const set = new Set<object>(); const weak = new WeakMap<object, number>();
  let head: LNode | null = null;
  for (let i = 0; i < 300000; i++) {
    const n = new LNode(i, head); head = n;
    if (i % 1000 === 0) { keep.push(n); map.set(n, i); set.add(n); weak.set(n, i); }
    const tmp = { a: i, b: [i] }; if (tmp.a < 0) keep.push(tmp as any);
  }
  let found = 0, ok = 0, wk = 0;
  for (const k of keep) { if (map.get(k) === k.id) found++; if (set.has(k)) ok++; if (weak.get(k) === k.id) wk++; }
  console.log(found, ok, wk, keep.length);
  const first = keep[0];
  let c: LNode | null = head; while (c && c.id !== first.id) c = c.next;
  console.log(c === first, c === keep[0], first instanceof LNode, Object.is(c, first), [first].indexOf(c!), [first].includes(c!), Object.getPrototypeOf(first) === LNode.prototype);
  const ps: any[] = []; for (let i = 0; i < 50000; i++) { const p = new (Plain as any)(i); if (i % 5000 === 0) ps.push(p); }
  console.log(ps.every((p) => p instanceof (Plain as any)), ps[1].v, ps.length);
  const bySwitch = (x: object) => { switch (x) { case first: return "first"; case keep[1]: return "second"; default: return "other"; } };
  console.log(bySwitch(c!), bySwitch(keep[1]), bySwitch(keep[2]));
}
main();
