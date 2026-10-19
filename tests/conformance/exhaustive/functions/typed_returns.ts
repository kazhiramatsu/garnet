// Direct entries return raw numbers and booleans: every return of a function
// is a raw numeric local (number) or a boolean produced in place (comparison,
// `!`, constant, another raw-boolean call); mixed, undefined-returning and
// parameter returns stay boxed. Results are used as values, conditions,
// operands, and through generic calls (callbacks, call/apply).
interface N { kind: number; flags: number; name?: string; next?: N; }
function kindOf(n: N): number { return n.kind; }
function flagsOr(n: N, extra: number): number { if (n.flags & 1) return n.flags | extra; return extra * 2; }
function isLeaf(n: N): boolean { return n.next === undefined; }
function hasName(n: N): boolean { return !!n.name; }
function notLeaf(n: N): boolean { return !isLeaf(n); }
function bothLeaf(a: N, b: N): boolean { const x = isLeaf(a); const y = isLeaf(b); return x && y; }
function eitherLeaf(a: N, b: N): boolean { return isLeaf(a) || isLeaf(b); }
function kindIs(n: N, k: number): boolean { return n.kind === k; }
function alwaysTrue(_n: N): boolean { return true; }
function viaConst(n: N): boolean { const r = n.kind > 1; return r; }
function passThrough(b: boolean): boolean { return b; }
function depth(n: N): number { let d = 0; let c: N | undefined = n; while (c) { d++; c = c.next; } return d; }
function maybeKind(n: N): number | undefined { if (n.flags & 2) return undefined; return n.kind; }
function mixed(n: N): number | boolean { if (n.flags & 4) return true; return n.kind; }
function nanKind(n: N): number { return n.kind === 0 ? NaN : n.kind / 2; }
function negZero(n: N): number { return n.kind === 0 ? -0 : 0; }
function bigKind(n: N): number { return n.kind * 4294967296 + 1; }
function cmpChain(a: N, b: N): boolean { return a.kind < b.kind; }
function throwsOrBool(n: N): boolean { if (n.kind < 0) throw new Error("neg"); return n.kind > 10; }
function tryBool(n: N): boolean { try { return throwsOrBool(n); } catch { return false; } }
function recur(n: N, k: number): number { return k === 0 ? n.kind : recur(n, k - 1) + 1; }
function finallyNum(n: N): number { try { return n.kind + 1; } finally { n.flags = n.flags | 8; } }
function finallyBool(n: N): boolean { try { try { return n.kind > 2; } finally { n.flags = n.flags | 16; } } finally { n.flags = n.flags | 32; } }
function finallyOverride(n: N): number { try { return 1; } finally { if (n.kind > 5) return 2; } }
function fromArray(xs: number[], i: number): number { return xs[i] * 2; }
function main(): void {
  const leaf: N = { kind: 3, flags: 1, name: "leaf" };
  const root: N = { kind: 0, flags: 6, next: { kind: 7, flags: 0, next: leaf } };
  const nodes = [leaf, root, root.next!];
  for (const n of nodes) {
    console.log(kindOf(n), flagsOr(n, 8), isLeaf(n), hasName(n), notLeaf(n), kindIs(n, 3), alwaysTrue(n), viaConst(n), passThrough(isLeaf(n)), depth(n));
    console.log(maybeKind(n), mixed(n), nanKind(n), Object.is(negZero(n), -0), bigKind(n), tryBool(n), recur(n, 3), fromArray([n.kind, 1], 0), fromArray([], 0));
    console.log(finallyNum(n), finallyBool(n), finallyOverride(n), n.flags);
    if (isLeaf(n)) console.log("leaf!"); else console.log("inner");
    if (!hasName(n) && kindIs(n, 0)) console.log("unnamed zero");
    const asValue = isLeaf(n); const sum = kindOf(n) + depth(n) * 10; const txt = String(isLeaf(n)) + typeof isLeaf(n) + typeof kindOf(n);
    console.log(asValue, asValue === true, sum, txt, [isLeaf(n), kindOf(n)], JSON.stringify({ b: hasName(n), k: kindOf(n) }));
    console.log(bothLeaf(n, leaf), eitherLeaf(n, root), cmpChain(n, leaf), isLeaf(n) ? "y" : "n", kindOf(n) > 2 && isLeaf(n), kindOf(n) - 0.5, -kindOf(n));
  }
  try { throwsOrBool({ kind: -1, flags: 0 }); } catch (e) { console.log(String(e)); }
  // generic entries: callbacks, call/apply, stored function values
  const preds: Array<(n: N) => boolean> = [isLeaf, hasName, notLeaf, alwaysTrue];
  console.log(preds.map((p) => p(leaf)).join(","), preds.filter((p) => p(root)).length, nodes.filter(isLeaf).length, nodes.map(kindOf).join("/"));
  console.log(isLeaf.call(null, root), kindOf.apply(null, [leaf]), nodes.some(isLeaf), nodes.every(hasName), nodes.map(depth));
  console.log([3, 1, 2].sort((a, b) => kindOf({ kind: a, flags: 0 }) - kindOf({ kind: b, flags: 0 })));
}
main();
