// Strict equality of two reference-typed operands: class instances, arrays,
// functions and object literals compare by identity; null and undefined
// compare by encoding; a union with a string member keeps the content
// compare (two equal strings in different cells are equal); a narrowed
// variable declared with a string member keeps it too; a number member keeps
// the numeric compare (+0 === -0, NaN !== NaN).
class AstNode { constructor(public kind: number, public parent: AstNode | undefined) {} }
class Sym { constructor(public name: string) {} }
function same(a: AstNode | undefined, b: AstNode | undefined): boolean { return a === b; }
function differ(a: AstNode, b: AstNode | null): boolean { return a !== b; }
function sameSym(a: Sym, b: Sym): boolean { return a === b; }
function sameOrStr(a: AstNode | string, b: AstNode | string): boolean { return a === b; }
function narrowed(a: AstNode | string, b: AstNode | string): boolean {
  if (typeof a !== "string" && typeof b !== "string") return a === b;
  return a === b;
}
function sameArr(a: number[], b: number[] | undefined): boolean { return a === b; }
function sameFn(a: () => void, b: (() => void) | null): boolean { return a === b; }
function sameNum(a: number | AstNode, b: number | AstNode): boolean { return a === b; }
function main() {
  const out: unknown[] = [];
  const root = new AstNode(1, undefined);
  const child = new AstNode(2, root);
  const other = new AstNode(2, root);
  out.push(same(child, child), same(child, other), same(child.parent, root), same(undefined, undefined), same(child.parent, undefined));
  out.push(differ(child, null), differ(child, child), differ(root, other));
  const s1 = new Sym("a"), s2 = new Sym("a");
  out.push(sameSym(s1, s1), sameSym(s1, s2));
  const parts = ["ab", "cd"]; const joined = parts.join(""); // "abcd" in a fresh cell
  out.push(sameOrStr("abcd", joined), sameOrStr(child, child), sameOrStr(child, "abcd"), narrowed("abcd", joined), narrowed(child, other), narrowed(child, child));
  const arr = [1, 2];
  out.push(sameArr(arr, arr), sameArr(arr, [1, 2]), sameArr(arr, undefined));
  const f = () => {}; const g = () => {};
  out.push(sameFn(f, f), sameFn(f, g), sameFn(f, null));
  out.push(sameNum(0, -0), sameNum(NaN, NaN), sameNum(3, 3), sameNum(child, child), sameNum(child, 2));
  // a loop over nodes comparing identities, the checker's pattern
  const nodes: AstNode[] = []; for (let i = 0; i < 50; i++) nodes.push(new AstNode(i, i % 7 === 0 ? root : child));
  let hits = 0; for (const n of nodes) { if (n.parent === root) hits++; if (n.parent !== child) hits += 10; }
  out.push(hits);
  console.log(JSON.stringify(out));
}
main();
