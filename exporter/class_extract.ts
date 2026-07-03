/**
 * ClassInfo extraction + shape-stability analysis.
 *
 * Produces, per class, the data the vtable/devirt backend needs:
 *   { id, name, parent, ownMethods (method/getter/setter), ownFields,
 *     instantiated, stable }
 * plus a per-call-site `recvStable` flag (false when the receiver flows through
 * `any`/a cast at that site).
 *
 * SOUNDNESS POSTURE: conservative. A class is `stable` ONLY if nothing in the
 * whole program is observed that could invalidate a fixed vtable / fixed layout.
 * Any of the following marks the class (and, where relevant, its subtree)
 * unstable, forcing the backend to dynamic dispatch:
 *   - assignment/delete on `C.prototype` or `C.prototype.m`
 *   - Object.setPrototypeOf / defineProperty / assign targeting the class/instances
 *   - method reassignment (`o.m = ...`) or dynamic property write (`o[expr] = ...`,
 *     or `o.newProp = ...` for a prop not declared on the class)
 *   - `extends <expr>` that is not a plain class reference (mixins), computed or
 *     symbol-named members, or a constructor that returns an object
 *   - the class type flowing through `any` / a cast (site-level recvStable=false)
 *
 * Unknowns default to UNSTABLE. We only claim stability we can see.
 */
import * as ts from "typescript";

/**
 * Resolve a class/object member name to its compile-time string key, or
 * `undefined` if it is dynamic (a variable, expression, or symbol) and must
 * stay rejected (the declaring class then falls back to `stable=false`).
 *   - Identifier / StringLiteral / PrivateIdentifier (keeps the leading '#') -> .text
 *   - NumericLiteral -> String(Number(text))  (JS coerces numeric keys to their string form)
 *   - ComputedPropertyName -> resolved only when its expression is a string/numeric literal
 * A well-known `[Symbol.iterator]` etc. yields `undefined` here on purpose, so
 * the dedicated wellKnownSym / wkName path keeps precedence at every call site.
 */
export function memberKeyName(nameNode: ts.PropertyName | undefined): string | undefined {
  if (!nameNode) return undefined;
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isPrivateIdentifier(nameNode))
    return nameNode.text;
  if (ts.isNumericLiteral(nameNode)) return String(Number(nameNode.text));
  if (ts.isComputedPropertyName(nameNode)) {
    const e = nameNode.expression;
    if (ts.isStringLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return String(Number(e.text));
  }
  return undefined; // dynamic / symbol
}

export type MKind = "method" | "getter" | "setter";

export interface MethodInfo { name: string; kind: MKind; isGenerator?: boolean; }
export interface ClassInfo {
  id: number;
  name: string;
  parentName?: string;
  /** The `extends` target's SYMBOL (lexical name resolution), captured for an
   *  identifier base. Resolving the parent via this symbol (not by name) is
   *  scope-correct: same-named classes in different scopes are distinct symbols.
   *  Not serialized (symbols are in-memory only); resolved to `parentId`. */
  parentSym?: ts.Symbol;
  /** The parent class id, resolved from `parentSym` via the symbol->id map. undefined
   *  when the parent is not a user class (a builtin like Error, or a binding the
   *  symbol map doesn't hold). This is the source of truth for parent lookups. */
  parentId?: number;
  ownMethods: MethodInfo[];
  ownFields: string[];
  instantiated: boolean;
  stable: boolean;
  reasons: string[]; // why it was marked unstable (diagnostics)
}

export interface ClassExtractionResult {
  classes: ClassInfo[];
  /** symbol of class declaration -> class id */
  symbolToId: Map<ts.Symbol, number>;
  /** class declaration/expression AST node -> class id (covers anonymous class
   *  expressions that have no name symbol to key by). */
  nodeToId: Map<ts.Node, number>;
}

export class ClassExtractor {
  private checker: ts.TypeChecker;
  private classes: ClassInfo[] = [];
  private bySymbol = new Map<ts.Symbol, number>();
  private byNode = new Map<ts.Node, number>();
  private nameToId = new Map<string, number>();
  private declOfId: ts.ClassLikeDeclaration[] = [];

  constructor(program: ts.Program) {
    this.checker = program.getTypeChecker();
  }

  private sym(node: ts.Node | undefined): ts.Symbol | undefined {
    const s = node ? this.checker.getSymbolAtLocation(node) : undefined;
    // Unwrap import aliases so a cross-module `extends X` / `new X()` resolves to
    // the original class declaration's symbol (the one registered in `bySymbol`),
    // not the per-module import-alias symbol. Mirrors exporter `unwrapImportAlias`
    // (§275 M4) — without this, cross-module inheritance silently loses its parent
    // (no proto/ctor linkage, instanceof false).
    if (s && (s.flags & ts.SymbolFlags.Alias)) {
      try { const t = this.checker.getAliasedSymbol(s); if (t) return t; } catch { /* keep original */ }
    }
    return s;
  }
  /** Strip parens / `as T` / `<T>e` / `e!` so we can see the real target. */
  private unwrap(e: ts.Expression): ts.Expression {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    }
    return cur;
  }
  private markUnstable(id: number, reason: string) {
    const c = this.classes[id];
    if (c.stable) c.stable = false;
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
  }
  private idOfClassSymbol(s: ts.Symbol | undefined): number | undefined {
    return s ? this.bySymbol.get(s) : undefined;
  }

  // ----- pass 1: declare classes, own members -----
  private declareClass(decl: ts.ClassLikeDeclaration) {
    const name = decl.name?.text ?? `anonClass${this.classes.length}`;
    const id = this.classes.length;
    const info: ClassInfo = {
      id, name, ownMethods: [], ownFields: [], instantiated: false, stable: true, reasons: [],
    };

    // extends clause: only a plain class reference keeps stability.
    const ext = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    if (ext && ext.types.length === 1) {
      const expr = ext.types[0].expression;
      if (ts.isIdentifier(expr)) {
        info.parentName = expr.text;
        // Capture the lexically-resolved symbol so the parent is identified by scope,
        // not by name (rule: `extends X` uses normal outer-scope name resolution).
        info.parentSym = this.sym(expr);
      } else {
        info.reasons.push("extends-non-identifier(mixin)");
        info.stable = false; // mixin / computed base: layout not statically known
      }
    }

    for (const m of decl.members) {
      const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
      const isStatic = !!mods?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
      if (isStatic || ts.isClassStaticBlockDeclaration(m)) continue;
      // computed or symbol names cannot be placed in a static vtable slot
      const nameNode = (m as any).name as ts.PropertyName | undefined;
      const computed = nameNode && ts.isComputedPropertyName(nameNode);
      // recognize the well-known [Symbol.iterator] / [Symbol.asyncIterator]
      // computed method names and map them to stable internal slot names so
      // for-of / for-await can resolve the iterable's iterator method.
      let wellKnownSym: string | undefined;
      if (computed && (ts.isMethodDeclaration(m))) {
        const e = (nameNode as ts.ComputedPropertyName).expression;
        const txt = e.getText();
        if (/Symbol\s*\.\s*iterator$/.test(txt)) wellKnownSym = "@@iterator";
        else if (/Symbol\s*\.\s*asyncIterator$/.test(txt)) wellKnownSym = "@@asyncIterator";
      }
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        // A literal computed key (`["m"]`, `[10]`) is just a normal named member.
        // Only a *dynamic* computed name (variable/expr/user-symbol) is rejected.
        const mn = wellKnownSym ?? memberKeyName(nameNode);
        if (mn === undefined) { info.reasons.push("computed-method-name(dynamic)"); info.stable = false; continue; }
        const kind: MKind = ts.isGetAccessor(m) ? "getter" : ts.isSetAccessor(m) ? "setter" : "method";
        const isGenerator = ts.isMethodDeclaration(m) && !!m.asteriskToken;
        info.ownMethods.push({ name: mn, kind, isGenerator });
      } else if (ts.isPropertyDeclaration(m)) {
        const fn = memberKeyName(nameNode);
        if (fn === undefined) { info.reasons.push("computed-field-name(dynamic)"); info.stable = false; continue; }
        // a property initialized to a function value is effectively a reassignable
        // method slot, not a fixed vtable entry; treat as a field (data) but note it.
        info.ownFields.push(fn);
      } else if (ts.isConstructorDeclaration(m)) {
        this.scanConstructor(m, info);
      }
    }

    this.classes.push(info);
    this.declOfId.push(decl);
    this.nameToId.set(name, id);
    this.byNode.set(decl, id);
    // Key by the class symbol. For a class declaration / named class expression
    // that's the name's symbol; for an ANONYMOUS class expression the binder
    // still assigns the node a class symbol (`(decl as any).symbol`), which is the
    // same symbol the instance type carries — so `new C()` on a `const C = class
    // {}` can resolve its classId from the result type. Register both when present.
    const s = (decl.name ? this.sym(decl.name) : undefined) ?? ((decl as { symbol?: ts.Symbol }).symbol);
    if (s) this.bySymbol.set(s, id);
  }

  // constructor: collect `this.x = ...` field declarations; flag dynamic writes
  // and an object-returning constructor (which would replace the instance).
  private scanConstructor(ctor: ts.ConstructorDeclaration, info: ClassInfo) {
    // parameter properties (e.g. `constructor(public x: number)`)
    for (const p of ctor.parameters) {
      if (p.modifiers?.some((mod) =>
        mod.kind === ts.SyntaxKind.PublicKeyword || mod.kind === ts.SyntaxKind.PrivateKeyword ||
        mod.kind === ts.SyntaxKind.ProtectedKeyword || mod.kind === ts.SyntaxKind.ReadonlyKeyword)) {
        if (ts.isIdentifier(p.name)) info.ownFields.push(p.name.text);
      }
    }
    const visit = (n: ts.Node) => {
      // this.field = ...
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const lhs = n.left;
        if (ts.isPropertyAccessExpression(lhs) && lhs.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const f = lhs.name.text;
          if (!info.ownFields.includes(f)) info.ownFields.push(f);
        } else if (ts.isElementAccessExpression(lhs) && lhs.expression.kind === ts.SyntaxKind.ThisKeyword) {
          info.reasons.push("dynamic-this-write"); // this[expr] = ...
          info.stable = false;
        }
      }
      if (ts.isReturnStatement(n) && n.expression) {
        // returning an object from a constructor replaces the new instance
        info.reasons.push("constructor-returns-value");
        info.stable = false;
      }
      n.forEachChild(visit);
    };
    if (ctor.body) ctor.body.forEachChild(visit);
  }

  // ----- pass 2: whole-program stability scan -----
  private scanStability(sf: ts.SourceFile) {
    const declaredFields = (id: number): Set<string> => {
      const s = new Set<string>();
      let cur: number | undefined = id;
      while (cur !== undefined) {
        const c = this.classes[cur];
        c.ownFields.forEach((f) => s.add(f));
        c.ownMethods.forEach((m) => s.add(m.name));
        cur = c.parentId; // symbol-resolved parent (scope-correct)
      }
      return s;
    };
    const classOfType = (t: ts.Type): number | undefined => {
      const sym = t.getSymbol();
      const id = this.idOfClassSymbol(sym);
      return id;
    };
    const typeIsAny = (t: ts.Type) => !!(t.flags & ts.TypeFlags.Any);

    const visit = (n: ts.Node) => {
      // new C(...) -> instantiated (RTA)
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
        let id = this.idOfClassSymbol(this.sym(n.expression));
        // Name-collision fallback: a user `class Node {}` colliding with an
        // ambient global (lib.dom's `Node`) resolves `sym` to the merged symbol
        // that isn't our map key. Fall back to the class name so RTA still marks
        // the user class instantiated (otherwise its field layout is dropped).
        if (id === undefined) id = this.nameToId.get(n.expression.text);
        // `new K()` where K is a variable holding a class value: its symbol is
        // the binding, not the class decl. Resolve via the result (instance) type
        // so RTA still marks the class instantiated (else its field descriptors
        // are dropped and dynamic field reads on the instance return undefined).
        if (id === undefined) {
          try {
            const it = this.checker.getTypeAtLocation(n);
            const isym = it.getSymbol && it.getSymbol();
            if (isym) id = this.idOfClassSymbol(isym);
          } catch { /* unresolved */ }
        }
        if (id !== undefined) this.classes[id].instantiated = true;
      }

      // assignment / delete targets (unwrap casts/parens on the LHS first)
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const lhs = this.unwrap(n.left);

        // C.prototype.x = ...  OR  C.prototype = ...
        if (ts.isPropertyAccessExpression(lhs)) {
          const base = this.unwrap(lhs.expression);
          // case: (C.prototype).m = ...
          if (ts.isPropertyAccessExpression(base) && base.name.text === "prototype" && ts.isIdentifier(this.unwrap(base.expression))) {
            const id = this.idOfClassSymbol(this.sym(this.unwrap(base.expression)));
            if (id !== undefined) this.markUnstable(id, "prototype-mutation");
          }
          // case: C.prototype = ...
          if (lhs.name.text === "prototype" && ts.isIdentifier(this.unwrap(lhs.expression))) {
            const id = this.idOfClassSymbol(this.sym(this.unwrap(lhs.expression)));
            if (id !== undefined) this.markUnstable(id, "prototype-assign");
          }
          // case: o.member = ...  (o is an instance, not `this`)
          if (base.kind !== ts.SyntaxKind.ThisKeyword) {
            const t = this.checker.getTypeAtLocation(base);
            const id = classOfType(t);
            if (id !== undefined) {
              const prop = lhs.name.text;
              const isPlainMethod = this.classMemberKindNames(id, "method").has(prop);
              const isAccessor = this.classMemberKindNames(id, "getter").has(prop) ||
                                 this.classMemberKindNames(id, "setter").has(prop);
              const declared = declaredFields(id);
              if (prop === "prototype") {
                /* handled above */
              } else if (isAccessor) {
                /* assigning through a setter / reading a getter is legitimate */
              } else if (isPlainMethod) {
                this.markUnstable(id, `method-reassign:${prop}`);
              } else if (!declared.has(prop)) {
                this.markUnstable(id, `dynamic-prop-write:${prop}`);
              }
            }
          }
        } else if (ts.isElementAccessExpression(lhs)) {
          const base = this.unwrap(lhs.expression);
          if (base.kind !== ts.SyntaxKind.ThisKeyword) {
            const t = this.checker.getTypeAtLocation(base);
            const id = classOfType(t);
            if (id !== undefined) this.markUnstable(id, "dynamic-elem-write");
          }
        }
      }

      // Object.setPrototypeOf / defineProperty / defineProperties
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "Object") {
        const meth = n.expression.name.text;
        if (meth === "setPrototypeOf" || meth === "defineProperty" || meth === "defineProperties") {
          const tgt = n.arguments[0] ? this.unwrap(n.arguments[0]) : undefined;
          if (tgt) {
            const t = this.checker.getTypeAtLocation(tgt);
            const id = classOfType(t);
            if (id !== undefined) this.markUnstable(id, `Object.${meth}`);
            if (ts.isPropertyAccessExpression(tgt) && tgt.name.text === "prototype" && ts.isIdentifier(this.unwrap(tgt.expression))) {
              const cid = this.idOfClassSymbol(this.sym(this.unwrap(tgt.expression)));
              if (cid !== undefined) this.markUnstable(cid, `Object.${meth}-on-prototype`);
            }
          }
        }
      }

      // delete o.x  /  delete (o as any).x
      if (ts.isDeleteExpression(n)) {
        const inner = this.unwrap(n.expression);
        if (ts.isPropertyAccessExpression(inner)) {
          const t = this.checker.getTypeAtLocation(this.unwrap(inner.expression));
          const id = classOfType(t);
          if (id !== undefined) this.markUnstable(id, "delete-member");
        }
      }

      n.forEachChild(visit);
    };
    visit(sf);
  }

  private classMemberKindNames(id: number, kind: MKind): Set<string> {
    const s = new Set<string>();
    let cur: number | undefined = id;
    while (cur !== undefined) {
      const c = this.classes[cur];
      c.ownMethods.forEach((m) => { if (m.kind === kind) s.add(m.name); });
      cur = c.parentId; // symbol-resolved parent (scope-correct)
    }
    return s;
  }
  private classMethodNames(id: number): Set<string> {
    const s = new Set<string>();
    let cur: number | undefined = id;
    while (cur !== undefined) {
      const c = this.classes[cur];
      c.ownMethods.forEach((m) => s.add(m.name));
      cur = c.parentId; // symbol-resolved parent (scope-correct)
    }
    return s;
  }

  /** Detect self/mutual `extends` cycles and break the parent links before any
   *  later pass walks the chain. JS would throw during class initialization; for
   *  this AOT subset we report it as an unsupported construct rather than hanging
   *  the compiler. */
  private breakParentCycles() {
    for (const start of this.classes) {
      const seen = new Map<number, number>();
      const path: number[] = [];
      let cur: number | undefined = start.id;
      while (cur !== undefined) {
        if (cur < 0 || cur >= this.classes.length) break;
        const first = seen.get(cur);
        if (first !== undefined) {
          for (const id of path.slice(first)) {
            this.markUnstable(id, "cyclic-extends");
            this.classes[id].parentId = undefined;
          }
          break;
        }
        seen.set(cur, path.length);
        path.push(cur);
        cur = this.classes[cur].parentId;
      }
    }
  }

  /** Is the receiver at a call site trustworthy as its declared class? false if
   *  the static type is `any` or the receiver is a cast (`expr as T`, `<T>expr`). */
  recvStableAt(recv: ts.Expression): boolean {
    if (ts.isAsExpression(recv) || ts.isTypeAssertionExpression(recv) || ts.isNonNullExpression(recv)) {
      // a cast/assertion is exactly where the declared type may not hold
      return false;
    }
    try {
      const t = this.checker.getTypeAtLocation(recv);
      if (t.flags & ts.TypeFlags.Any) return false;
    } catch { return false; }
    return true;
  }

  extract(sf: ts.SourceFile): ClassExtractionResult {
    return this.extractAll([sf]);
  }

  /** Extract classes across MULTIPLE modules (the bundler). All classes from
   *  every module are declared first (so cross-module `extends` resolves by
   *  symbol), then parents/cycles/stability are computed once over the whole set.
   *  Class ids accumulate across files (declareClass uses classes.length). */
  extractAll(sfs: ts.SourceFile[]): ClassExtractionResult {
    const walk = (n: ts.Node) => {
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) this.declareClass(n);
      n.forEachChild(walk);
    };
    for (const sf of sfs) walk(sf);
    // Resolve each class's parent to a class id via its SYMBOL (scope-correct), now
    // that every class is declared (bySymbol is complete; declaration order / forward
    // references / cross-module extends don't matter). A parent symbol that isn't a
    // user class (a builtin like Error, or a `const K = class {}` binding) stays undefined.
    for (const ci of this.classes) {
      ci.parentId = ci.parentSym ? this.bySymbol.get(ci.parentSym) : undefined;
    }
    this.breakParentCycles();
    for (const sf of sfs) this.scanStability(sf);
    return { classes: this.classes, symbolToId: this.bySymbol, nodeToId: this.byNode };
  }
}
