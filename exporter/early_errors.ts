// JavaScript's early errors that TypeScript's parser and checker let through. Each of these is a program V8
// refuses before running it (every file is an ES module, so always strict and with `await` reserved), so a
// compile of one stops: anything else would run a program that has no meaning.
import * as ts from "typescript";

export interface EarlyError { node: ts.Node; message: string }

const isFunctionBoundary = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isConstructorDeclaration(n);

const isEvalOrArguments = (n: ts.Node): n is ts.Identifier =>
  ts.isIdentifier(n) && (n.text === "eval" || n.text === "arguments");

const isStatic = (m: ts.ClassElement): boolean => (ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) !== 0;

/** Is this identifier a name a program binds or reads, rather than a property's or a type's? */
function isBindingOrReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p)) return p.expression === n;
  if (ts.isQualifiedName(p) || ts.isTypeReferenceNode(p) || ts.isTypeNode(p)) return false;
  if (ts.isPropertyAssignment(p)) return p.initializer === n;
  if (ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) {
    return ts.isPropertyDeclaration(p) && p.initializer === n;
  }
  if (ts.isBindingElement(p)) return p.name === n || p.initializer === n;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isNamespaceExport(p) || ts.isJsxAttribute(p) ||
      ts.isMetaProperty(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

/** A class body's private names, with the duplicates its members declare: one getter and one setter of a
 *  name (both static or neither) are the one pair the grammar allows. */
function privateNamesOf(c: ts.ClassLikeDeclaration, out: EarlyError[]): Set<string> {
  const seen = new Map<string, { kind: "get" | "set" | "other"; isStatic: boolean; paired?: boolean }>();
  for (const m of c.members) {
    if (!m.name || !ts.isPrivateIdentifier(m.name)) continue;
    const kind = ts.isGetAccessorDeclaration(m) ? "get" : ts.isSetAccessorDeclaration(m) ? "set" : "other";
    const first = seen.get(m.name.text);
    if (first === undefined) { seen.set(m.name.text, { kind, isStatic: isStatic(m) }); continue; }
    const pair = kind !== "other" && first.kind !== "other" && first.kind !== kind && first.isStatic === isStatic(m) && !first.paired;
    if (!pair) out.push({ node: m.name, message: `the private name '${m.name.text}' is declared twice` });
    first.paired = true;
  }
  return new Set(seen.keys());
}

export function jsEarlyErrors(sf: ts.SourceFile): EarlyError[] {
  const out: EarlyError[] = [];
  const privateScopes: Set<string>[] = [];
  /** `eval` or `arguments` as a target, through parentheses and patterns. */
  const checkTarget = (e: ts.Expression): void => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (isEvalOrArguments(e)) out.push({ node: e, message: `'${e.text}' cannot be assigned to in strict mode` });
    else if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) {
        if (ts.isSpreadElement(el)) checkTarget(el.expression);
        else if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) checkTarget(el.left);
        else if (!ts.isOmittedExpression(el)) checkTarget(el);
      }
    } else if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isShorthandPropertyAssignment(p)) { if (isEvalOrArguments(p.name)) out.push({ node: p.name, message: `'${p.name.text}' cannot be assigned to in strict mode` }); }
        else if (ts.isSpreadAssignment(p)) checkTarget(p.expression);
        else if (ts.isPropertyAssignment(p)) {
          const v = p.initializer;
          checkTarget(ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.EqualsToken ? v.left : v);
        }
      }
    }
  };
  /** LexicallyDeclaredNames of a block or a case block: a duplicate. In strict code a function in a block is one of them. */
  const checkLexicalDuplicates = (statements: readonly ts.Statement[]): void => {
    const seen = new Set<string>();
    const note = (name: ts.Identifier): void => {
      if (seen.has(name.text)) out.push({ node: name, message: `Identifier '${name.text}' has already been declared` });
      seen.add(name.text);
    };
    // the VarDeclaredNames under the statements: a `var` hoists through the block
    const vars: ts.Identifier[] = [];
    const walkVars = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.BlockScoped)) {
        for (const d of n.declarations) if (ts.isIdentifier(d.name)) vars.push(d.name);
      }
      ts.forEachChild(n, walkVars);
    };
    for (const s of statements) walkVars(s);
    for (const s of statements) {
      if (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.BlockScoped)) {
        for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) note(d.name);
      } else if ((ts.isClassDeclaration(s) || (ts.isFunctionDeclaration(s) && s.body !== undefined)) && s.name !== undefined) note(s.name);
    }
    for (const v of vars) if (seen.has(v.text)) out.push({ node: v, message: `Identifier '${v.text}' has already been declared` });
  };
  /** ContainsArguments: a field initializer or a static block may not name `arguments`. An arrow is no boundary. */
  const checkNoArguments = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === "arguments" && isBindingOrReference(n)) {
      out.push({ node: n, message: "'arguments' is not allowed in a class field initializer or a static block" });
      return;
    }
    if (isFunctionBoundary(n)) {
      const name = (n as ts.MethodDeclaration).name;
      if (name && ts.isComputedPropertyName(name)) checkNoArguments(name);   // a method's computed key belongs to the class
      return;
    }
    ts.forEachChild(n, checkNoArguments);
  };
  /** The rule for an arrow's parameters: no `await` or `yield` expression in them. */
  const checkArrowParameters = (n: ts.Node): void => {
    if (ts.isAwaitExpression(n) || ts.isYieldExpression(n)) {
      out.push({ node: n, message: `an arrow function's parameters may not contain ${ts.isAwaitExpression(n) ? "await" : "yield"}` });
      return;
    }
    if (isFunctionBoundary(n) || ts.isArrowFunction(n) || ts.isClassLike(n)) return;
    ts.forEachChild(n, checkArrowParameters);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBlock(n) && !ts.isFunctionLike(n.parent)) checkLexicalDuplicates(n.statements);
    else if (ts.isSourceFile(n)) {
      // two default exports, or an exported name twice
      const exported = new Set<string>();
      const exportName = (node: ts.Node, name: string): void => {
        if (exported.has(name)) out.push({ node, message: `Duplicate export of '${name}'` });
        exported.add(name);
      };
      for (const s of n.statements) {
        if (ts.isExportAssignment(s) && !s.isExportEquals) exportName(s, "default");
        else if (ts.isExportDeclaration(s) && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) {
          for (const e of s.exportClause.elements) exportName(e, e.name.text);
        } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          if (s.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) exportName(s, "default");
          else if (s.name !== undefined && (ts.isClassDeclaration(s) || s.body !== undefined)) exportName(s, s.name.text);
        } else if (ts.isVariableStatement(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) exportName(d, d.name.text);
        }
      }
    }
    else if (ts.isCaseBlock(n)) checkLexicalDuplicates(n.clauses.flatMap((c) => [...c.statements]));
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      checkTarget(n.left);
    } else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
               (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      checkTarget(n.operand);
    } else if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      checkTarget(n.initializer);
    } else if (ts.isIdentifier(n) && n.text === "await" && isBindingOrReference(n)) {
      out.push({ node: n, message: "'await' is a reserved word in a module" });
    } else if (ts.isPropertyAccessExpression(n) && ts.isPrivateIdentifier(n.name)) {
      if (n.expression.kind === ts.SyntaxKind.SuperKeyword) out.push({ node: n, message: "'super' has no private names" });
      else if (!privateScopes.some((s) => s.has(n.name.text))) out.push({ node: n.name, message: `the private name '${n.name.text}' is not declared in an enclosing class` });
    } else if (ts.isArrowFunction(n)) {
      for (const p of n.parameters) checkArrowParameters(p);
    }
    if (ts.isClassLike(n)) {
      // the heritage runs in the enclosing classes' scope, the body in this class's too
      for (const h of n.heritageClauses ?? []) visit(h);
      if (n.name) visit(n.name);
      for (const mod of n.modifiers ?? []) visit(mod);
      privateScopes.push(privateNamesOf(n, out));
      for (const m of n.members) {
        const nm = (m as { name?: ts.PropertyName }).name;
        if (nm && !ts.isComputedPropertyName(nm) && !ts.isPrivateIdentifier(nm) && isStatic(m)) {
          const key = ts.isIdentifier(nm) || ts.isStringLiteralLike(nm) ? nm.text : undefined;
          if (key === "prototype" || (key === "constructor" && ts.isPropertyDeclaration(m)))
            out.push({ node: nm, message: `a class may not have a static member named '${key}'` });
        }
        if (ts.isPropertyDeclaration(m) && m.initializer) checkNoArguments(m.initializer);
        if (ts.isClassStaticBlockDeclaration(m)) checkNoArguments(m.body);
        visit(m);
      }
      privateScopes.pop();
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
