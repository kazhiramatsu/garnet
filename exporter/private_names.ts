// Private names (docs/private_names_design.md). `#x` is a name of the class body that declares it, not a
// property: two classes on one chain each have their own, and no string reaches it. The exporter's paths read
// a member's name as text, so each declaring class's names are given a spelling of their own in the AST, right
// after parsing and before the checker binds: `#x` becomes `#x<MARK><n>`, at every use the name resolves to
// lexically. A program cannot write that key, and the runtime knows it by the mark.
import * as ts from "typescript";

export const PRIVATE_MARK = "\u0001";
let nextClass = 0;
const done = new WeakSet<ts.SourceFile>();

export function uniquePrivateNames(sf: ts.SourceFile): void {
  if (done.has(sf)) return;
  done.add(sf);
  const scopes: Map<string, string>[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isClassLike(n)) {
      for (const h of n.heritageClauses ?? []) visit(h);
      const names = new Map<string, string>();
      for (const m of n.members) {
        const nm = (m as { name?: ts.PropertyName }).name;
        if (nm && ts.isPrivateIdentifier(nm) && nm.text !== "#constructor" && !names.has(nm.text)) {
          names.set(nm.text, `${nm.text}${PRIVATE_MARK}${names.size === 0 ? ++nextClass : nextClass}`);
        }
      }
      scopes.push(names);
      for (const m of n.members) visit(m);
      scopes.pop();
      return;
    }
    if (ts.isPrivateIdentifier(n)) {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const u = scopes[i].get(n.text);
        if (u !== undefined) { (n as { escapedText: ts.__String }).escapedText = u as ts.__String; return; }
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** The name as the program spells it: what `fn.name` and an error message show. */
export function privateDisplayName(name: string): string {
  const i = name.indexOf(PRIVATE_MARK);
  return i < 0 ? name : name.slice(0, i);
}

/** The hidden field of a class with instance private methods or accessors: its presence is the brand they
 *  check, as a private field's own slot is. */
export function privateBrand(c: ts.ClassLikeDeclaration): string | undefined {
  for (const m of c.members) {
    const nm = (m as { name?: ts.PropertyName }).name;
    if (!nm || !ts.isPrivateIdentifier(nm) || ts.isPropertyDeclaration(m)) continue;
    if (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) continue;
    const i = nm.text.indexOf(PRIVATE_MARK);
    if (i >= 0) return `#brand${nm.text.slice(i)}`;
  }
  return undefined;
}
