// `using` and `await using` (docs/using_declarations_design.md): a source rewrite before the program is built. The
// declarations stay what they are to the checker, a `const` of the initializer's type, and the statements keep their
// lines: the keyword becomes `const`, the initializer a call that registers the resource, and the statement list that holds
// them moves into a try whose finally disposes.
import * as ts from "typescript";

function hasUsing(list: ts.VariableDeclarationList): "sync" | "await" | undefined {
  // a binding pattern or a missing initializer is left as it is: the exporter refuses what it finds
  if (list.declarations.some((d) => !ts.isIdentifier(d.name) || d.initializer === undefined && !ts.isForOfStatement(list.parent))) return undefined;
  const kind = list.flags & ts.NodeFlags.BlockScoped;
  if (kind === ts.NodeFlags.Using) return "sync";
  if (kind === ts.NodeFlags.AwaitUsing) return "await";
  return undefined;
}
/** Text edits: an insertion at `pos`, or a replacement of [pos, end). */
type Edit = { pos: number; end: number; text: string };

export function rewriteUsing(source: ts.SourceFile): string | undefined {
  if (!/\busing\b/.test(source.text)) return undefined;
  const sf = ts.createSourceFile(source.fileName, source.text, source.languageVersion, true);   /* with parents */
  const edits: Edit[] = [];
  let counter = 0;
  let any = false;
  const insert = (pos: number, text: string): void => { edits.push({ pos, end: pos, text }); };
  /** The using declarations directly in these statements (not in nested blocks). */
  const declarationsIn = (statements: readonly ts.Statement[]): { list: ts.VariableDeclarationList; kind: "sync" | "await" }[] => {
    const out: { list: ts.VariableDeclarationList; kind: "sync" | "await" }[] = [];
    for (const s of statements) {
      if (!ts.isVariableStatement(s)) continue;
      const kind = hasUsing(s.declarationList);
      if (kind !== undefined) out.push({ list: s.declarationList, kind });
    }
    return out;
  };
  const rewriteList = (list: ts.VariableDeclarationList, kind: "sync" | "await", stack: string): void => {
    any = true;
    edits.push({ pos: list.getStart(sf), end: list.declarations[0].getStart(sf), text: "const " });
    for (const d of list.declarations) {
      insert(d.initializer!.getStart(sf), `__garnet_use_of(`);
      insert(d.initializer!.end, `, ${stack}, ${kind === "await" ? 1 : 0})`);
    }
  };
  const prologue = (stack: string): string => `const ${stack}: any = (globalThis as any).__garnet_using_stack(); try { `;
  const epilogue = (stack: string, isAwait: boolean): string =>
    ` } catch (${stack}c) { ${stack}.failure.has = true; ${stack}.failure.error = ${stack}c; } finally { ${isAwait ? `await (globalThis as any).__garnet_dispose_async(${stack})` : `(globalThis as any).__garnet_dispose(${stack})`}; }`;
  /** A statement list with using declarations: all of it goes into the try, so function hoisting is what it was. */
  const wrap = (statements: readonly ts.Statement[], start: number, end: number, found: { list: ts.VariableDeclarationList; kind: "sync" | "await" }[]): void => {
    const stack = `__garnet_u${counter++}`;
    for (const d of found) rewriteList(d.list, d.kind, stack);
    insert(start, prologue(stack));
    insert(end, epilogue(stack, found.some((d) => d.kind === "await")));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBlock(n) || ts.isModuleBlock(n)) {
      const found = declarationsIn(n.statements);
      if (found.length > 0) wrap(n.statements, n.getStart(sf) + 1, n.end - 1, found);
    } else if (ts.isSourceFile(n)) {
      const found = declarationsIn(n.statements);
      if (found.length > 0) {
        // the module's imports stay at the top; an export cannot move into a block
        const firstBody = n.statements.findIndex((s) => !ts.isImportDeclaration(s) && !ts.isImportEqualsDeclaration(s));
        wrap(n.statements.slice(firstBody), n.statements[firstBody].getFullStart(), n.end, found);
      }
    } else if (ts.isCaseBlock(n)) {
      const statements = n.clauses.flatMap((c) => [...c.statements]);
      const found = declarationsIn(statements);
      if (found.length > 0) {
        const stack = `__garnet_u${counter++}`;
        for (const d of found) rewriteList(d.list, d.kind, stack);
        const sw = n.parent;
        insert(sw.getStart(sf), `{ ${prologue(stack)}`);
        insert(sw.end, `${epilogue(stack, found.some((d) => d.kind === "await"))} }`);
      }
    } else if ((ts.isForOfStatement(n) || ts.isForStatement(n)) && n.initializer !== undefined && ts.isVariableDeclarationList(n.initializer)) {
      const kind = hasUsing(n.initializer);
      if (kind !== undefined) {
        const stack = `__garnet_u${counter++}`;
        any = true;
        if (ts.isForOfStatement(n)) {
          // each iteration has its resource
          const d = n.initializer.declarations[0];
          const value = `${stack}v`;
          edits.push({ pos: n.initializer.getStart(sf), end: n.initializer.end, text: `const ${value}` });
          insert(n.statement.getStart(sf), `{ ${prologue(stack)}const ${d.name.getText(sf)} = __garnet_use_of(${value}, ${stack}, ${kind === "await" ? 1 : 0}); `);
          insert(n.statement.end, `${epilogue(stack, kind === "await")} }`);
        } else {
          rewriteList(n.initializer, kind, stack);
          insert(n.getStart(sf), `{ ${prologue(stack)}`);
          insert(n.end, `${epilogue(stack, kind === "await")} }`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!any) return undefined;
  // later edits first; at one position the insertions closing a nested scope come before those opening one
  const ordered = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.pos - a.pos || b.i - a.i);
  let text = sf.text;
  for (const e of ordered) text = text.slice(0, e.pos) + e.text + text.slice(e.end);
  return text + "\nfunction __garnet_use_of<T>(value: T, stack: any, isAsync: number): T { return (globalThis as any).__garnet_use(value, stack, isAsync); }\n";
}
