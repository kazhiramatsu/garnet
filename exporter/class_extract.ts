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
/** The globals the Node prelude provides as classes of lib/node (exporter.ts NODE_PRELUDE_CTORS). */
const PRELUDE_CLASS_NAMES = new Set(["Headers", "Request", "Response", "FormData", "DataView", "URL", "URLSearchParams", "Crypto", "SubtleCrypto", "CryptoKey",
  "ReadableStream", "WritableStream", "TransformStream", "ReadableStreamDefaultReader", "WritableStreamDefaultWriter", "ReadableStreamDefaultController", "WritableStreamDefaultController", "TransformStreamDefaultController", "TextEncoderStream", "TextDecoderStream", "CountQueuingStrategy", "ByteLengthQueuingStrategy", "Blob", "File",
  "CompressionStream", "DecompressionStream"]);

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

/** `a.b.C`: identifiers joined by property accesses (an entity name). */
function isQualifiedName(e: ts.Expression): boolean {
  return ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) && isQualifiedName(e.expression));
}

export type MKind = "method" | "getter" | "setter";

export interface MethodInfo { name: string; kind: MKind; isGenerator?: boolean; }
/** A class with no members over a base that is a runtime value (`class D extends Parent {}` with
 *  `Parent` a binding, a call or a member expression): it is not laid out as a class; the exporter
 *  lowers it to a derived constructor over the value (`ts_class_extend_dyn`). A base naming a class
 *  declaration or a library class (Error) stays a class. Returns the base expression when it applies. */
export function dynamicBaseEmptyClass(decl: ts.ClassLikeDeclaration, checker: ts.TypeChecker): ts.Expression | undefined {
  if (decl.members.length !== 0) return undefined;
  const ext = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  if (!ext || ext.types.length !== 1) return undefined;
  const expr = ext.types[0].expression;
  if (ts.isIdentifier(expr) || (ts.isPropertyAccessExpression(expr) && isQualifiedName(expr))) {
    let sym = checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name);
    if (sym && (sym.flags & ts.SymbolFlags.Alias)) sym = checker.getAliasedSymbol(sym);
    const decls = sym?.getDeclarations() ?? [];
    if (decls.length === 0) return undefined;   // unresolved: the class path reports it
    if (decls.some((d) => ts.isClassDeclaration(d) || ts.isClassExpression(d))) return undefined;   // a class
    if (decls.every((d) => d.getSourceFile().isDeclarationFile)) return undefined;   // a library class
    return expr;   // a binding that holds a constructor value
  }
  return expr;   // a call, an element access, a conditional: a mixin or a runtime value
}

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
  /** The fields only `this.x = ...` in the constructor declares: an accessor of that name, here or
   *  above, takes the store instead (`dropAccessorStores`). Not serialized. */
  ctorAssigned?: string[];
  instantiated: boolean;
  stable: boolean;
  reasons: string[]; // why it was marked unstable (diagnostics)
}

/** docs/closed_receivers_design.md: whether the program can reach none of
 *  the runtime points that raise g_typed_slow, and the sites that open it. */
export interface ClosedReceivers {
  closed: boolean;
  /** the first sites found (`what at file:line`), for TSAOT_CLOSED_LOG */
  reasons: string[];
  /** every site found */
  count: number;
}

export interface ClassExtractionResult {
  classes: ClassInfo[];
  /** symbol of class declaration -> class id */
  symbolToId: Map<ts.Symbol, number>;
  /** class declaration/expression AST node -> class id (covers anonymous class
   *  expressions that have no name symbol to key by). */
  nodeToId: Map<ts.Node, number>;
  closedReceivers: ClosedReceivers;
}

export class ClassExtractor {
  private checker: ts.TypeChecker;
  private program: ts.Program;
  private classes: ClassInfo[] = [];
  private bySymbol = new Map<ts.Symbol, number>();
  private byNode = new Map<ts.Node, number>();
  private nameToId = new Map<string, number>();
  private declOfId: ts.ClassLikeDeclaration[] = [];

  constructor(program: ts.Program) {
    this.program = program;
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
  /** The receiver of a property write as its class is read: parentheses
   *  and `!` stripped, a cast through `any` or `unknown` looked through, any
   *  other cast kept (its type is the receiver's). */
  private writeReceiver(e: ts.Expression): ts.Expression {
    let cur = e;
    for (;;) {
      if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) { cur = cur.expression; continue; }
      if ((ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur)) &&
          (cur.type.kind === ts.SyntaxKind.AnyKeyword || cur.type.kind === ts.SyntaxKind.UnknownKeyword)) {
        cur = cur.expression;
        continue;
      }
      return cur;
    }
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
    if (dynamicBaseEmptyClass(decl, this.checker)) return;   // a derived constructor over a runtime value, not a class
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
      } else if (ts.isPropertyAccessExpression(expr) && isQualifiedName(expr)) {
        // `extends ns.Base`: a qualified name of a class resolves like a name
        info.parentName = expr.name.text;
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
        // `declare x: T` is an ambient declaration: the instance has no such
        // own property at run time (no struct slot, no key), exactly as V8
        // erases it. The compiler's `SymbolLinks` is a brand-only class of
        // this form, instantiated once per symbol (Session 350).
        if (mods?.some((mod) => mod.kind === ts.SyntaxKind.DeclareKeyword)) continue;
        // `abstract x: T` likewise emits nothing: a subclass implements it with a field of its own,
        // laid out in its own order, or with an accessor on its prototype, which a slot here would hide.
        if (mods?.some((mod) => mod.kind === ts.SyntaxKind.AbstractKeyword)) continue;
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
          if (!info.ownFields.includes(f)) {
            info.ownFields.push(f);
            (info.ctorAssigned ??= []).push(f);
          }
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

  /** `this.w = v` in a constructor with an accessor `w` on the class or an ancestor runs the setter: no
   *  field, no own key. Runs once every class is declared, the parents resolved. */
  private dropAccessorStores(): void {
    for (const info of this.classes) {
      if (!info.ctorAssigned) continue;
      const accessor = (f: string): boolean => {
        for (let c: ClassInfo | undefined = info; c; c = c.parentId !== undefined ? this.classes[c.parentId] : undefined) {
          if (c.ownMethods.some((m) => m.name === f && (m.kind === "getter" || m.kind === "setter"))) return true;
        }
        return false;
      };
      info.ownFields = info.ownFields.filter((f) => !(info.ctorAssigned!.includes(f) && accessor(f)));
      delete info.ctorAssigned;
    }
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
          // case: o.member = ...  (o is an instance, not `this`). The
          // receiver is read as the cast says (`(node as Identifier).flowNode
          // = f` writes Identifier's field), except through `any` / `unknown`
          // (`(o as any).extra = v` adds a property to o's class instance).
          if (base.kind !== ts.SyntaxKind.ThisKeyword) {
            const t = this.checker.getTypeAtLocation(this.writeReceiver(lhs.expression));
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

  // ----- pass 3: structural flows -----
  // TypeScript types classes structurally: an object literal, an instance of
  // an unrelated class, or an interface-typed value is assignable to a class
  // type without private members, and `any`, `unknown` and casts admit any
  // value. A typed field access is a struct offset and a call on a
  // class-typed receiver is bound to the class's method, so such a value read
  // through the class type yielded another field's value or ran the wrong
  // method (silent wrong values). A class such a value can reach is marked
  // unstable: its receivers take the dynamic paths. Reached means: a flow
  // into a position typed with the class (an initializer, an assignment, an
  // argument, a return, a property or element of a literal, a default: every
  // contextually typed expression; a cast; a type guard; a type argument
  // against its parameter's constraint), then on from there through flows
  // between classes (an upcast or a downcast carries the value along) and to
  // the ancestors (an inherited method reads its `this` as the ancestor).
  private flowSeed = new Map<number, string>();
  private flowEdges = new Map<number, Set<number>>();
  private leafCache = new Map<ts.Type, Map<number, ts.Type>>();

  /** The class (instance type, not `typeof C`) a type names, if any. */
  private classIdOfInstanceType(t: ts.Type): number | undefined {
    const id = this.idOfClassSymbol(t.getSymbol());
    if (id === undefined) return undefined;
    return t.getConstructSignatures().length > 0 ? undefined : id;
  }
  /** The classes a value of type `t` may be read as: `t`, union and
   *  intersection members, type arguments (arrays, tuples, generic types) and,
   *  two levels deep, property types of other object types; a type parameter
   *  by its constraint. Class id -> a representative instance type. */
  private classLeaves(t: ts.Type): Map<number, ts.Type> {
    const hit = this.leafCache.get(t);
    if (hit) return hit;
    const out = new Map<number, ts.Type>();
    this.leafCache.set(t, out);
    const seen = new Set<ts.Type>();
    const walk = (u: ts.Type, depth: number): void => {
      if (seen.has(u) || depth > 3) return;
      seen.add(u);
      if (u.isUnionOrIntersection()) { for (const m of u.types) walk(m, depth); return; }
      if (u.flags & ts.TypeFlags.TypeParameter) {
        const c = u.getConstraint();
        if (c) walk(c, depth);
        return;
      }
      const id = this.classIdOfInstanceType(u);
      if (id !== undefined) { if (!out.has(id)) out.set(id, u); return; }
      if (!(u.flags & ts.TypeFlags.Object)) return;
      if (((u as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) {
        for (const a of this.checker.getTypeArguments(u as ts.TypeReference)) walk(a, depth + 1);
      }
      if (depth >= 2) return;
      for (const p of this.checker.getPropertiesOfType(u)) {
        if (p.flags & ts.SymbolFlags.Method) continue;
        let pt: ts.Type;
        try { pt = this.checker.getTypeOfSymbol(p); } catch { continue; }
        walk(pt, depth + 1);
      }
    };
    walk(t, 0);
    return out;
  }
  private isAncestorClass(a: number, c: number): boolean {
    for (let cur = this.classes[c].parentId; cur !== undefined; cur = this.classes[cur].parentId) {
      if (cur === a) return true;
    }
    return false;
  }
  private relatedClasses(a: number, b: number): boolean {
    return a === b || this.isAncestorClass(a, b) || this.isAncestorClass(b, a);
  }
  /** ` at file:line` for the structural flow log. */
  private flowSite(n: ts.Node): string {
    if (process.env.TSAOT_STRUCTURAL_LOG !== "1") return "";
    const sf = n.getSourceFile();
    return ` at ${sf.fileName.split("/").slice(-2).join("/")}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  }
  private seedFlow(c: number, reason: string): void {
    if (!this.flowSeed.has(c)) this.flowSeed.set(c, reason);
  }
  private flowEdge(d: number, c: number): void {
    let e = this.flowEdges.get(d);
    if (!e) this.flowEdges.set(d, (e = new Set()));
    e.add(c);
  }
  private flowDone = new Set<string>();
  /** A value of type `s` flows into a position of type `t` (`kind` "flow":
   *  TypeScript checked `s` assignable to `t`; "cast" and "guard" narrow: the
   *  value is claimed to be a `t`). Matched by position: union members one by
   *  one, a class target against the source as a whole, other object targets
   *  property by property, type arguments argument by argument. */
  private flowInto(s: ts.Type, t: ts.Type, kind: string, at: ts.Node, depth: number): void {
    if (s === t || depth > 4) return;
    if (this.classLeaves(t).size === 0) return;
    const sid = (s as unknown as { id?: number }).id, tid = (t as unknown as { id?: number }).id;
    const memo = sid !== undefined && tid !== undefined ? `${sid}:${tid}:${kind}` : undefined;
    if (memo !== undefined) { if (this.flowDone.has(memo)) return; this.flowDone.add(memo); }
    const narrows = kind !== "flow";
    if (s.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      for (const c of this.classLeaves(t).keys()) this.seedFlow(c, `${kind}: any${this.flowSite(at)}`);
      return;
    }
    if (s.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never)) return;
    if (s.flags & ts.TypeFlags.TypeParameter) {
      const c = s.getConstraint();
      if (c) this.flowInto(c, t, kind, at, depth);
      else if (narrows) for (const k of this.classLeaves(t).keys()) this.seedFlow(k, `${kind}: ${this.checker.typeToString(s)}${this.flowSite(at)}`);
      return;
    }
    if (s.isUnion()) {
      let members = s.types;
      // A cast or a guard picks the target out of a union: the members
      // unrelated to the target's classes are the alternatives it excludes.
      if (narrows) {
        const tcs = this.topClasses(t);
        const related = members.filter((m) => {
          const d = this.classIdOfInstanceType(m);
          return d !== undefined && tcs.some((c) => this.relatedClasses(d, c));
        });
        if (related.length > 0) members = related;
      }
      for (const m of members) this.flowInto(m, t, kind, at, depth);
      return;
    }
    if (s.isIntersection()) {
      // a value of `T & C` is a C (an `instanceof` narrowing of a type parameter)
      const cls = s.types.filter((m) => this.classIdOfInstanceType(m) !== undefined);
      if (cls.length > 0) { for (const m of cls) this.flowInto(m, t, kind, at, depth); return; }
    }
    if (t.isUnionOrIntersection()) {
      for (const m of t.types) this.flowInto(s, m, kind, at, depth);
      return;
    }
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const c = t.getConstraint();
      if (c) this.flowInto(s, c, kind, at, depth);
      return;
    }
    const c = this.classIdOfInstanceType(t);
    if (c !== undefined) {
      const d = this.classIdOfInstanceType(s);
      if (d !== undefined) {
        if (d === c) return;
        if (this.relatedClasses(d, c)) { this.flowEdge(d, c); return; }
        if (narrows || this.checker.isTypeAssignableTo(s, t)) {
          this.seedFlow(c, `${kind}: class ${this.classes[d].name}${this.flowSite(at)}`);
        }
        return;
      }
      if (narrows || this.checker.isTypeAssignableTo(s, t)) {
        this.seedFlow(c, `${kind}: ${this.checker.typeToString(s)}${this.flowSite(at)}`);
      }
      return;
    }
    if (!(t.flags & ts.TypeFlags.Object) || !(s.flags & ts.TypeFlags.Object)) return;
    const isRef = (u: ts.Type) => (((u as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0);
    if (isRef(t) && isRef(s)) {
      const targs = this.checker.getTypeArguments(t as ts.TypeReference);
      const sargs = this.checker.getTypeArguments(s as ts.TypeReference);
      const same = (s as ts.TypeReference).target === (t as ts.TypeReference).target;
      for (let j = 0; j < targs.length; j++) {
        if (this.classLeaves(targs[j]).size === 0) continue;
        if (same) { if (j < sargs.length) this.flowInto(sargs[j], targs[j], kind, at, depth + 1); }
        else for (const a of sargs) this.flowInto(a, targs[j], kind, at, depth + 1);
      }
    }
    for (const tp of this.checker.getPropertiesOfType(t)) {
      if (tp.flags & ts.SymbolFlags.Method) continue;
      let tpt: ts.Type;
      try { tpt = this.checker.getTypeOfSymbol(tp); } catch { continue; }
      if (this.classLeaves(tpt).size === 0) continue;
      const sp = this.checker.getPropertyOfType(s, tp.name);
      if (!sp) continue;
      let spt: ts.Type;
      try { spt = this.checker.getTypeOfSymbol(sp); } catch { continue; }
      this.flowInto(spt, tpt, kind, at, depth + 1);
    }
    const tix = this.checker.getIndexTypeOfType(t, ts.IndexKind.String);
    if (tix && this.classLeaves(tix).size > 0) {
      const six = this.checker.getIndexTypeOfType(s, ts.IndexKind.String);
      if (six) this.flowInto(six, tix, kind, at, depth + 1);
      for (const sp of this.checker.getPropertiesOfType(s)) {
        if (sp.flags & ts.SymbolFlags.Method) continue;
        try { this.flowInto(this.checker.getTypeOfSymbol(sp), tix, kind, at, depth + 1); } catch { /* skip */ }
      }
    }
  }
  /** `new Map()` and the like: a library container constructed empty holds
   *  no value yet (its zero-argument signature says `Map<any, any>`). */
  private emptyLibraryValue(n: ts.Node): boolean {
    if (!ts.isNewExpression(n) || (n.arguments !== undefined && n.arguments.length > 0)) return false;
    const sym = this.checker.getTypeAtLocation(n).getSymbol();
    const decls = sym?.getDeclarations() ?? [];
    return decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
  }
  /** The classes `t` names at its top level (itself or a union member). */
  private topClasses(t: ts.Type): number[] {
    const out: number[] = [];
    for (const m of t.isUnion() ? t.types : [t]) {
      const c = this.classIdOfInstanceType(m);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  /** The expression a cast reinterprets: through the `as unknown` / `as any`
   *  steps of a double cast (`e as unknown as C` reinterprets `e`). */
  private castSource(e: ts.Expression): ts.Expression {
    let cur = e;
    for (;;) {
      while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
      if ((ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur)) &&
          (cur.type.kind === ts.SyntaxKind.UnknownKeyword || cur.type.kind === ts.SyntaxKind.AnyKeyword)) {
        cur = cur.expression;
        continue;
      }
      return cur;
    }
  }
  private scanStructuralFlows(sf: ts.SourceFile): void {
    const checker = this.checker;
    const typeArgs = (n: ts.CallExpression | ts.NewExpression): void => {
      let sig: ts.Signature | undefined;
      try { sig = checker.getResolvedSignature(n); } catch { return; }
      if (!sig) return;
      const args = checker.getTypeArgumentsForResolvedSignature(sig);
      if (!args || args.length === 0) return;
      const gen = sig.declaration && !ts.isJSDocSignature(sig.declaration) ? checker.getSignatureFromDeclaration(sig.declaration) : undefined;
      const params = gen?.getTypeParameters() ?? (sig as { target?: ts.Signature }).target?.getTypeParameters();
      if (!params) return;
      for (let i = 0; i < params.length && i < args.length; i++) {
        const c = params[i].getConstraint();
        if (c) this.flowInto(args[i], c, "flow", n, 0);
      }
    };
    const visit = (n: ts.Node): void => {
      try {
        // (a cast's operand is contextually typed by the cast's type: the
        // cast check below reads what it reinterprets)
        const castOperand = n.parent !== undefined && (ts.isAsExpression(n.parent) || ts.isTypeAssertionExpression(n.parent)) &&
          n.parent.expression === n;
        // (a property's or declaration's name is not a value; `{ x }` is)
        const nameSlot = ts.isIdentifier(n) && n.parent !== undefined && !ts.isShorthandPropertyAssignment(n.parent) &&
          (n.parent as { name?: ts.Node }).name === n;
        // (the operands of `??`, `||`, `&&`, `,` and the branches of `?:` are
        // contextually typed themselves; the whole adds nothing but its
        // operands' union, an empty `new Map()`'s `Map<any, any>` included)
        const passes = ts.isConditionalExpression(n) || (ts.isBinaryExpression(n) && (
          n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.CommaToken));
        if (ts.isExpression(n) && !ts.isParenthesizedExpression(n) && !castOperand && !nameSlot && !passes && !this.emptyLibraryValue(n)) {
          const ct = checker.getContextualType(n);
          if (ct && this.classLeaves(ct).size > 0) {
            const st = checker.getTypeAtLocation(n);
            // A literal's elements and properties are checked one by one (each
            // is contextually typed); the literal itself is a new object that
            // is not an instance of any class.
            const literal = (ts.isObjectLiteralExpression(n) && !n.properties.some(ts.isSpreadAssignment)) ||
              (ts.isArrayLiteralExpression(n) && !n.elements.some(ts.isSpreadElement));
            if (literal) {
              for (const c of this.topClasses(ct)) {
                const ctype = (ct.isUnion() ? ct.types : [ct]).find((m) => this.classIdOfInstanceType(m) === c)!;
                if (checker.isTypeAssignableTo(st, ctype)) this.seedFlow(c, `flow: ${checker.typeToString(st)}${this.flowSite(n)}`);
              }
            } else {
              this.flowInto(st, ct, "flow", n, 0);
            }
          }
        }
        if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
          this.flowInto(checker.getTypeAtLocation(this.castSource(n.expression)), checker.getTypeFromTypeNode(n.type), "cast", n, 0);
        }
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) typeArgs(n);
        if (ts.isExpressionWithTypeArguments(n) && n.typeArguments && n.typeArguments.length > 0) {
          const bt = checker.getTypeAtLocation(n);
          const params = (bt as { target?: ts.InterfaceType }).target?.typeParameters;
          if (params && (((bt as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0)) {
            const args = checker.getTypeArguments(bt as ts.TypeReference);
            for (let i = 0; i < params.length && i < args.length; i++) {
              const c = params[i].getConstraint();
              if (c) this.flowInto(args[i], c, "flow", n, 0);
            }
          }
        }
        if (ts.isTypePredicateNode(n) && n.type) {
          const fn = n.parent;
          const guarded = ts.isIdentifier(n.parameterName) && ts.isFunctionLike(fn)
            ? fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === (n.parameterName as ts.Identifier).text)
            : undefined;
          let from: ts.Type | undefined;
          if (guarded) from = checker.getTypeAtLocation(guarded.name);
          else if (n.parameterName.kind === ts.SyntaxKind.ThisType) {
            const cls = ts.findAncestor(fn, ts.isClassLike);
            if (cls) { const id = this.byNode.get(cls); if (id !== undefined) from = checker.getTypeAtLocation(cls.name ?? cls); }
          }
          if (from) this.flowInto(from, checker.getTypeFromTypeNode(n.type), "guard", n, 0);
        }
      } catch { /* a checker failure leaves the flow unrecorded */ }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  private closeStructuralFlows(): void {
    const work = [...this.flowSeed.keys()];
    const done = new Set<number>();
    while (work.length > 0) {
      const c = work.pop()!;
      if (done.has(c)) continue;
      done.add(c);
      this.markUnstable(c, `structural-flow (${this.flowSeed.get(c)})`);
      const next: [number, string][] = [];
      const p = this.classes[c].parentId;
      if (p !== undefined) next.push([p, `subclass ${this.classes[c].name}`]);
      for (const d of this.flowEdges.get(c) ?? []) next.push([d, `from ${this.classes[c].name}`]);
      for (const [d, why] of next) {
        if (done.has(d)) continue;
        this.seedFlow(d, why);
        work.push(d);
      }
    }
    if (process.env.TSAOT_STRUCTURAL_LOG === "1") {
      for (const c of done) process.stderr.write(`[structural] ${this.classes[c].name}: ${this.flowSeed.get(c)}\n`);
    }
  }

  // ----- pass 4: closed receivers (docs/closed_receivers_design.md) -----
  // Every typed field access tests g_typed_slow, which the runtime raises
  // where an object without a class's struct layout can come to be read as
  // the class: a Proxy; a relink behind a class prototype
  // (Object.setPrototypeOf, Reflect.setPrototypeOf, Object.create); a
  // struct method called with another `this` (call, apply, bind,
  // Reflect.apply, the thisArg of an iteration method). A program whose
  // source reaches none of them, by name or by any dynamic route, has closed
  // receivers: the flag stays down for the whole run, so its test can go.
  private openReasons: string[] = [];
  private openCount = 0;
  private openAt(n: ts.Node, what: string): void {
    this.openCount++;
    if (this.openReasons.length >= 40) return;
    const sf = n.getSourceFile();
    this.openReasons.push(`${what} at ${sf.fileName.split("/").slice(-2).join("/")}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
  }
  private fromDefaultLib(sym: ts.Symbol | undefined): boolean {
    const decls = sym?.declarations ?? [];
    return decls.length > 0 && decls.every((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }
  /** `Owner.name` of a member the default library declares (an interface
   *  or namespace member: `ObjectConstructor.create`, `Reflect.apply`). */
  private libMemberOf(sym: ts.Symbol | undefined): string | undefined {
    if (!sym || !this.fromDefaultLib(sym)) return undefined;
    for (const d of sym.declarations ?? []) {
      let owner: ts.Node | undefined = d.parent;
      if (owner && ts.isModuleBlock(owner)) owner = owner.parent;
      if (owner && (ts.isInterfaceDeclaration(owner) || ts.isModuleDeclaration(owner)) && ts.isIdentifier(owner.name)) {
        return `${owner.name.text}.${sym.name}`;
      }
    }
    return undefined;
  }
  /** `call` or `apply` as the default library declares it on its Function interfaces: the member a
   *  function-typed receiver names (the exporter lowers `f.call(t, ...)` to the runtime's implementation). */
  isFunctionProtoCallOrApply(sym: ts.Symbol | undefined): boolean {
    const m = this.libMemberOf(sym);
    return m === "Function.call" || m === "Function.apply" || m === "CallableFunction.call" || m === "CallableFunction.apply" ||
      m === "NewableFunction.call" || m === "NewableFunction.apply";
  }
  /** A value the default library declares under `name` (`declare var Proxy`). */
  private libValue(sym: ts.Symbol | undefined, name: string): boolean {
    return !!sym && sym.name === name && (sym.flags & ts.SymbolFlags.Value) !== 0 && this.fromDefaultLib(sym);
  }
  /** A function that cannot be a class method: a function or arrow
   *  expression, a function declaration, a library function
   *  (`Object.prototype.hasOwnProperty`, `Math.max`), a `const` initialized
   *  with one of these. */
  private plainFunction(e: ts.Expression, depth = 0): boolean {
    let cur = e;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) return true;
    if (ts.isPropertyAccessExpression(cur)) return this.fromDefaultLib(this.checker.getSymbolAtLocation(cur.name));
    if (!ts.isIdentifier(cur)) return false;
    const sym = this.sym(cur);
    if (this.fromDefaultLib(sym)) return (sym!.flags & ts.SymbolFlags.Function) !== 0;
    const d = sym?.valueDeclaration;
    if (d && ts.isFunctionDeclaration(d)) return true;
    if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) !== 0 && depth < 4) {
      return this.plainFunction(d.initializer, depth + 1);
    }
    return false;
  }
  /** A `this` for a borrowed call that the runtime does not count as
   *  foreign: an instance of a stable class with struct fields (a sized
   *  instance; a field-less class's instances are plain objects). */
  private sizedThis(e: ts.Expression | undefined): boolean {
    if (!e) return false;
    const t = this.checker.getTypeAtLocation(e);
    if (!this.stableInstances(t) || (t.flags & ts.TypeFlags.Union && (t as ts.UnionType).types.some((m) =>
        (m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0))) return false;
    for (let m of t.isUnion() ? t.types : [t]) {
      if (m.flags & ts.TypeFlags.TypeParameter) m = m.getConstraint() ?? m;
      const id = this.classIdOfInstanceType(m);
      if (id === undefined || !this.hasStructFields(id)) return false;
    }
    return true;
  }
  private hasStructFields(id: number): boolean {
    for (let cur: number | undefined = id; cur !== undefined; cur = this.classes[cur].parentId) {
      if (this.classes[cur].ownFields.length > 0) return true;
    }
    return false;
  }
  private dynamicType(t: ts.Type): boolean {
    return (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  }
  /** Every value of type `t` (null and undefined aside) is an instance of a
   *  stable class: not a function, not a builtin namespace. */
  private stableInstances(t: ts.Type): boolean {
    let some = false;
    for (let m of t.isUnion() ? t.types : [t]) {
      if (m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue;
      if (m.flags & ts.TypeFlags.TypeParameter) m = m.getConstraint() ?? m;
      const id = this.classIdOfInstanceType(m);
      if (id === undefined || !this.classes[id].stable) return false;
      some = true;
    }
    return some;
  }
  /** An identifier used as a value (not a type, a declared name, a property
   *  name or an import / export specifier). */
  private valuePosition(id: ts.Identifier): boolean {
    const p = id.parent;
    if (!p) return false;
    if (ts.isPropertyAccessExpression(p)) return p.expression === id;
    if (ts.isQualifiedName(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) ||
        ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)) return false;
    if (!ts.isShorthandPropertyAssignment(p) && (p as { name?: ts.Node }).name === id) return false;
    if (ts.isPropertyAssignment(p) && p.name === id) return false;
    for (let q: ts.Node | undefined = p; q && !ts.isStatement(q) && !ts.isSourceFile(q); q = q.parent) {
      if (ts.isTypeNode(q) && !ts.isExpressionWithTypeArguments(q)) return false;
      if (ts.isHeritageClause(q)) return q.token === ts.SyntaxKind.ExtendsKeyword;
    }
    return true;
  }
  private scanClosedReceivers(sf: ts.SourceFile): void {
    const checker = this.checker;
    const RELINK = new Set(["ObjectConstructor.setPrototypeOf", "ObjectConstructor.create", "Reflect.setPrototypeOf"]);
    const BORROW = new Set(["Function.call", "Function.apply", "Function.bind", "CallableFunction.call",
      "CallableFunction.apply", "CallableFunction.bind", "NewableFunction.call", "NewableFunction.apply",
      "NewableFunction.bind", "Reflect.apply"]);
    // members reached by name through an `any` receiver or a computed key
    const NAMES = ["setPrototypeOf", "create", "call", "apply", "bind"];
    const THISARG = new Set(["every", "filter", "find", "findIndex", "findLast", "findLastIndex", "flatMap",
      "forEach", "map", "some", "from"]);
    const GLOBALS = new Set(["Proxy", "Function", "Object", "Reflect"]);
    const callOf = (n: ts.Node): ts.CallExpression | undefined =>
      n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n ? n.parent : undefined;
    // `Object.create(null)`, `Object.setPrototypeOf(o, null)`: no prototype
    const nullProto = (n: ts.Node, member: string): boolean => {
      const call = callOf(n);
      const arg = call?.arguments[member === "ObjectConstructor.create" ? 0 : 1];
      return arg !== undefined && arg.kind === ts.SyntaxKind.NullKeyword;
    };
    // a value of type `t` may hold one of the members by name
    const holdsBuiltin = (t: ts.Type): boolean => {
      if (t.getCallSignatures().length > 0 || t.getConstructSignatures().length > 0) return true;
      const at = checker.getApparentType(t);
      for (const name of [...NAMES, ...GLOBALS]) {
        const p = checker.getPropertyOfType(at, name);
        if (!p) continue;
        const m = this.libMemberOf(p);
        if ((m && (RELINK.has(m) || BORROW.has(m))) || this.libValue(p, name)) return true;
      }
      return false;
    };
    const member = (n: ts.Node, name: string, recv: ts.Expression, sym: ts.Symbol | undefined): void => {
      if (name === "__proto__") { this.openAt(n, "__proto__"); return; }
      if (GLOBALS.has(name) && this.libValue(sym, name)) { this.openAt(n, `${name} read as a property`); return; }
      const lib = this.libMemberOf(sym);
      if (lib && RELINK.has(lib)) { if (!nullProto(n, lib)) this.openAt(n, lib); return; }
      if (lib && BORROW.has(lib)) {
        // (a method read directly, `x.m.call(t)`, is pass 5's: it accepts a
        // `this` of the method's class only)
        const call = callOf(n);
        let r: ts.Expression = recv;
        while (ts.isParenthesizedExpression(r)) r = r.expression;
        const recvSym = ts.isPropertyAccessExpression(r) ? checker.getSymbolAtLocation(r.name)
          : ts.isElementAccessExpression(r) && ts.isStringLiteralLike(r.argumentExpression)
            ? checker.getPropertyOfType(checker.getApparentType(checker.getTypeAtLocation(r.expression)), r.argumentExpression.text) : undefined;
        // (a static method is never a struct method: it lives on the class value, not the
        // prototype, so borrowing one is a plain function call)
        const direct = this.methodClassOf(recvSym) !== undefined;
        if (lib === "Reflect.apply") { this.openAt(n, lib); return; }
        if (!direct && !(this.plainFunction(recv) || (call !== undefined && this.sizedThis(call.arguments[0])))) {
          // a function value that is not syntactically a plain function: it can be a struct
          // method only if the program reads a method as a value somewhere (pass 5 decides)
          this.deferredBorrows.push({ node: n, what: lib });
        }
        return;
      }
      if (lib) return;
      const t = checker.getTypeAtLocation(recv);
      if (this.dynamicType(t)) {
        if (NAMES.includes(name) || GLOBALS.has(name)) this.openAt(n, `${name} of an any value`);
        else if (THISARG.has(name) && (callOf(n)?.arguments.length ?? 0) >= 2) this.openAt(n, `${name}(callback, thisArg) of an any value`);
        return;
      }
      // a user-declared `call` / `apply` / `bind` that is a function (an
      // interface member) on a value a function can satisfy structurally may
      // be the builtin at run time; a data property of another type (a
      // record's `call: Node`) is not
      if ((name === "call" || name === "apply" || name === "bind") && !this.stableInstances(t) && !this.plainFunction(recv)) {
        const mt = checker.getTypeAtLocation(n);
        if (this.dynamicType(mt) || mt.getCallSignatures().length > 0) this.openAt(n, `${name} of a value that may be a function`);
      }
    };
    const visit = (n: ts.Node): void => {
      try {
        if (ts.isIdentifier(n) && GLOBALS.has(n.text) && this.valuePosition(n) && this.libValue(checker.getSymbolAtLocation(n), n.text)) {
          const p = n.parent;
          const asObject = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n;
          const asCallee = (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n;
          const tested = ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === n;
          if (n.text === "Proxy") this.openAt(n, "Proxy");
          else if (n.text === "Function" ? asCallee : false) this.openAt(n, "the Function constructor");
          else if (!asObject && !asCallee && !tested && !ts.isTypeOfExpression(p)) this.openAt(n, `${n.text} as a value`);
        }
        if (ts.isPropertyAccessExpression(n)) member(n, n.name.text, n.expression, checker.getSymbolAtLocation(n.name));
        if (ts.isElementAccessExpression(n)) {
          const k = n.argumentExpression;
          if (ts.isStringLiteralLike(k)) {
            const sym = checker.getPropertyOfType(checker.getApparentType(checker.getTypeAtLocation(n.expression)), k.text);
            member(n, k.text, n.expression, sym);
          } else if (!ts.isNumericLiteral(k)) {
            const t = checker.getTypeAtLocation(n.expression);
            if (this.dynamicType(t)) this.openAt(n, "a computed key on an any value");
            else if (holdsBuiltin(t)) this.openAt(n, "a computed key on a function or a builtin namespace");
          }
        }
        if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n) ||
             ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && n.parent && ts.isObjectLiteralExpression(n.parent)) {
          const nm = n.name;
          if ((ts.isIdentifier(nm) || ts.isStringLiteral(nm)) && nm.text === "__proto__") this.openAt(n, "a __proto__ literal key");
        }
        if (ts.isBindingElement(n) && n.parent && ts.isObjectBindingPattern(n.parent)) {
          const key = n.propertyName ?? n.name;
          const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
          if (name === undefined && n.propertyName && ts.isComputedPropertyName(n.propertyName)) {
            const t = checker.getTypeAtLocation(n.parent);
            if (this.dynamicType(t) || holdsBuiltin(t)) this.openAt(n, "a computed key in a pattern");
          } else if (name !== undefined && (NAMES.includes(name) || GLOBALS.has(name) || name === "__proto__")) {
            const t = checker.getTypeAtLocation(n.parent);
            if (this.dynamicType(t) || holdsBuiltin(t)) this.openAt(n, `${name} taken by a pattern`);
          }
        }
        if (ts.isCallExpression(n)) {
          // a library method's thisArg (`arr.forEach(cb, ctx)`) binds the callback to it
          const sig = checker.getResolvedSignature(n);
          const decl = sig?.declaration;
          if (sig && decl && !ts.isJSDocSignature(decl) && this.program.isSourceFileDefaultLibrary(decl.getSourceFile())) {
            const params = sig.getParameters();
            for (let i = 0; i < params.length && i < n.arguments.length; i++) {
              if (params[i].name !== "thisArg") continue;
              const callbacks = n.arguments.slice(0, i).filter((a) => checker.getTypeAtLocation(a).getCallSignatures().length > 0 ||
                this.dynamicType(checker.getTypeAtLocation(a)));
              if (!callbacks.every((a) => this.plainFunction(a)) && !this.sizedThis(n.arguments[i])) this.openAt(n, "a thisArg");
            }
          }
        }
      } catch { this.openAt(n, "a site the checker could not resolve"); }
      n.forEachChild(visit);
    };
    visit(sf);
  }

  // ----- pass 5: method values (docs/closed_receivers_design.md, slice 2) -----
  // A class method's typed `this` accesses assume an instance of its class.
  // A method read as a value can run with any `this` (grafted onto another
  // object, borrowed, called bare): each such site is noted at run time
  // (`class.methodEscape` raises the flag, so typed accesses test the class
  // interval from then on) and opens the program's receivers. Not a value:
  // a call (`x.m()`), `typeof x.m`, a borrow with a `this` of the method's
  // class (`x.m.call(t)`, `x.m.bind(t)`, an iteration method's thisArg),
  // which the runtime's borrow check accepts.
  readonly methodEscapes = new Set<ts.Node>();
  private escapeCounts = new Map<string, number>();
  /** Borrows (`f.call(t)`, `f.apply(t, a)`, `f.bind(t)`) of function values that may be
   *  methods: they open the program only if pass 5 finds a method read as a value. */
  private deferredBorrows: { node: ts.Node; what: string }[] = [];
  private escapeAt(n: ts.Node, what: string): void {
    this.methodEscapes.add(n);
    this.openAt(n, what);
    this.escapeCounts.set(what, (this.escapeCounts.get(what) ?? 0) + 1);
  }
  /** The user class declaring an instance method symbol, if it is one. */
  /** The library's class behind a Web or URL global the Node prelude provides
   *  (docs/web_fetch_api_design.md), by the global's name. */
  private preludeClassByName(name: string): number | undefined {
    for (const [node, id] of this.byNode) {
      if (ts.isClassLike(node) && node.name !== undefined && node.name.text === name && node.getSourceFile().fileName.includes("/lib/node/")) return id;
    }
    return undefined;
  }
  private methodClassOf(sym: ts.Symbol | undefined): number | undefined {
    if (!sym || !(sym.flags & ts.SymbolFlags.Method)) return undefined;
    const d = sym.valueDeclaration ?? sym.declarations?.[0];
    // a method of a Web or URL class the Node prelude provides: the identifier's type is
    // lib.dom's interface, the value the library's class, whose method escapes as a value here
    if (d && ts.isMethodSignature(d) && d.parent && ts.isInterfaceDeclaration(d.parent) &&
        PRELUDE_CLASS_NAMES.has(d.parent.name.text) && this.program.isSourceFileDefaultLibrary(d.getSourceFile())) {
      return this.preludeClassByName(d.parent.name.text);
    }
    if (!d || !ts.isMethodDeclaration(d) || !d.parent || !ts.isClassLike(d.parent)) return undefined;
    if (d.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return undefined;
    return this.byNode.get(d.parent);
  }
  /** `t` is an instance of class `c` or a subclass of it (a sized, stable
   *  class: the runtime's borrow check accepts such a `this`). */
  private relatedThis(c: number, t: ts.Expression | undefined): boolean {
    if (!t || !this.sizedThis(t)) return false;
    const tt = this.checker.getNonNullableType(this.checker.getTypeAtLocation(t));
    for (let m of tt.isUnion() ? tt.types : [tt]) {
      if (m.flags & ts.TypeFlags.TypeParameter) m = m.getConstraint() ?? m;
      const d = this.classIdOfInstanceType(m);
      if (d === undefined || !(d === c || this.isAncestorClass(c, d))) return false;
    }
    return true;
  }
  /** Every value of `e`'s type (null and undefined aside) is a record or an
   *  array: its type has an index signature, which no class instance type
   *  satisfies, so a `delete` on it cannot reach a class field. */
  private indexedOnly(e: ts.Expression): boolean {
    const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(e));
    if (this.dynamicType(t)) return false;
    for (const m of t.isUnion() ? t.types : [t]) {
      const at = this.checker.getApparentType(m);
      if (this.classIdOfInstanceType(m) !== undefined) return false;
      if (!this.checker.getIndexTypeOfType(at, ts.IndexKind.String) && !this.checker.getIndexTypeOfType(at, ts.IndexKind.Number)) return false;
    }
    return true;
  }
  private scanMethodEscapes(sf: ts.SourceFile): void {
    const checker = this.checker;
    const methodNames = new Set<string>();
    for (const c of this.classes) for (const m of c.ownMethods) if (m.kind === "method") methodNames.add(m.name);
    const callee = (n: ts.Node): boolean => !!n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n;
    const maybeInstance = (t: ts.Type): boolean =>
      this.dynamicType(t) || this.topClasses(checker.getNonNullableType(t)).length > 0;
    const methodOfAccess = (n: ts.PropertyAccessExpression | ts.ElementAccessExpression): number | undefined => {
      const sym = ts.isPropertyAccessExpression(n) ? checker.getSymbolAtLocation(n.name)
        : checker.getPropertyOfType(checker.getApparentType(checker.getTypeAtLocation(n.expression)), (n.argumentExpression as ts.StringLiteral).text);
      return this.methodClassOf(sym);
    };
    // a library call's thisArg for its callbacks (`arr.forEach(cb, t)`)
    const thisArgOf = (call: ts.CallExpression): ts.Expression | undefined => {
      const sig = checker.getResolvedSignature(call);
      const decl = sig?.declaration;
      if (!sig || !decl || ts.isJSDocSignature(decl) || !this.program.isSourceFileDefaultLibrary(decl.getSourceFile())) return undefined;
      const i = sig.getParameters().findIndex((p) => p.name === "thisArg");
      return i >= 0 ? call.arguments[i] : undefined;
    };
    const visit = (n: ts.Node): void => {
      try {
        if (ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression))) {
          const cls = methodOfAccess(n);
          if (cls !== undefined && !callee(n)) {
            const p = n.parent;
            if (p && ts.isPropertyAccessExpression(p) && ["call", "apply", "bind"].includes(p.name.text) && callee(p)) {
              if (!this.relatedThis(cls, (p.parent as ts.CallExpression).arguments[0])) this.escapeAt(n, "a method borrowed with another this");
            } else if (p && ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) {
              if (!this.relatedThis(cls, thisArgOf(p))) this.escapeAt(n, "a method passed as a value");
            } else if (!(p && ts.isTypeOfExpression(p))) {
              this.escapeAt(n, "a method read as a value");
            }
          } else if (cls === undefined && ts.isPropertyAccessExpression(n) && !callee(n) && methodNames.has(n.name.text) &&
                     this.dynamicType(checker.getTypeAtLocation(n.expression)) && !(n.parent && ts.isTypeOfExpression(n.parent))) {
            this.escapeAt(n, "a method name read from an any value");
          }
        }
        if (ts.isElementAccessExpression(n) && !ts.isStringLiteralLike(n.argumentExpression) && !ts.isNumericLiteral(n.argumentExpression) &&
            !callee(n) && maybeInstance(checker.getTypeAtLocation(n.expression))) {
          this.escapeAt(n, "a computed key on a class instance");
        }
        // a property descriptor or a reflected read hands out a method or an accessor as a value
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.arguments.length > 0) {
          const m = this.libMemberOf(checker.getSymbolAtLocation(n.expression.name));
          if ((m === "ObjectConstructor.getOwnPropertyDescriptor" || m === "ObjectConstructor.getOwnPropertyDescriptors" ||
               m === "Reflect.getOwnPropertyDescriptor" || m === "Reflect.get") && maybeInstance(checker.getTypeAtLocation(n.arguments[0]))) {
            this.escapeAt(n, "a descriptor of a class instance");
          }
        }
        if (ts.isBindingElement(n) && n.parent && ts.isObjectBindingPattern(n.parent) && !n.dotDotDotToken) {
          const src = checker.getTypeAtLocation(n.parent);
          const key = n.propertyName ?? n.name;
          if (ts.isComputedPropertyName(key)) {
            if (maybeInstance(src)) this.escapeAt(n, "a computed key in a pattern");
          } else if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
            const p = checker.getPropertyOfType(checker.getApparentType(src), key.text);
            if (this.methodClassOf(p) !== undefined || (this.dynamicType(src) && methodNames.has(key.text))) this.escapeAt(n, "a method taken by a pattern");
          }
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(n.left)) {
          const src = checker.getTypeAtLocation(n.right);
          for (const pr of n.left.properties) {
            const nm = pr.name;
            const name = nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm)) ? nm.text : undefined;
            const p = name !== undefined ? checker.getPropertyOfType(checker.getApparentType(src), name) : undefined;
            if ((nm && ts.isComputedPropertyName(nm) && maybeInstance(src)) || this.methodClassOf(p) !== undefined ||
                (name !== undefined && this.dynamicType(src) && methodNames.has(name))) {
              this.escapeAt(n, "a method taken by a destructuring assignment");
              break;
            }
          }
        }
        // `delete` of a class field turns the instance into a plain object
        // and raises the flag: on a value that may be a class instance (one
        // whose type has no index signature), it opens the program
        if (ts.isDeleteExpression(n)) {
          let e: ts.Expression = n.expression;
          while (ts.isParenthesizedExpression(e)) e = e.expression;
          if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && !this.indexedOnly(e.expression)) {
            this.openAt(n, "delete of a property of a value that may be a class instance");
          }
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
            this.libMemberOf(checker.getSymbolAtLocation(n.expression.name)) === "Reflect.deleteProperty" &&
            !(n.arguments[0] !== undefined && this.indexedOnly(n.arguments[0]))) {
          this.openAt(n, "Reflect.deleteProperty of a value that may be a class instance");
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
          const lib = this.libMemberOf(checker.getSymbolAtLocation(n.expression.name));
          if ((lib === "ObjectConstructor.getOwnPropertyDescriptor" || lib === "ObjectConstructor.getOwnPropertyDescriptors" ||
               lib === "Reflect.get" || lib === "Reflect.getOwnPropertyDescriptor") &&
              n.arguments[0] !== undefined && maybeInstance(checker.getTypeAtLocation(n.arguments[0]))) {
            this.escapeAt(n, `${lib} of a class instance`);
          }
        }
      } catch { this.escapeAt(n, "a site the checker could not resolve"); }
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
      // An `extends` the class table does not record: a library class
      // (Error, Array, ...) or a value that is not a class declaration (a
      // class-valued constant). The runtime prototype chain then has an
      // ancestor outside the table's intervals
      // (docs/class_index_dispatch_design.md).
      if (ci.parentSym !== undefined && ci.parentId === undefined) {
        const decls = ci.parentSym.getDeclarations() ?? [];
        const library = decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
        ci.reasons.push(library ? `extends-library(${ci.parentName ?? "?"})` : "extends-value(unresolved)");
      }
    }
    this.breakParentCycles();
    this.dropAccessorStores();
    for (const sf of sfs) this.scanStability(sf);
    for (const sf of sfs) this.scanStructuralFlows(sf);
    this.closeStructuralFlows();
    for (const sf of sfs) this.scanClosedReceivers(sf);
    for (const sf of sfs) this.scanMethodEscapes(sf);
    if (this.methodEscapes.size > 0) {
      for (const b of this.deferredBorrows) this.openAt(b.node, `${b.what} (the program reads methods as values)`);
    }
    if (process.env.TSAOT_ESCAPE_LOG === "1") {
      for (const [k, v] of this.escapeCounts) process.stderr.write(`[escape] ${v} ${k}\n`);
    }
    const closedReceivers = { closed: this.openCount === 0, reasons: this.openReasons, count: this.openCount };
    if (process.env.TSAOT_CLOSED_LOG === "1") {
      process.stderr.write(`[closed] receivers ${closedReceivers.closed ? "closed" : `open (${this.openCount} sites)`}\n`);
      for (const r of this.openReasons) process.stderr.write(`[closed]   ${r}\n`);
    }
    // TSAOT_DEBUG_ALL_UNSTABLE=1: every class dispatches dynamically (a
    // debugging mode that exercises the dynamic paths of a typed program)
    if (process.env.TSAOT_DEBUG_ALL_UNSTABLE === "1") {
      for (let id = 0; id < this.classes.length; id++) this.markUnstable(id, "debug-all-unstable");
    }
    // TSAOT_DEBUG_UNSTABLE_CLASSES=<regex>: the classes whose names match
    // dispatch dynamically (bisecting a defect of the dynamic paths)
    if (process.env.TSAOT_DEBUG_UNSTABLE_CLASSES) {
      const re = new RegExp(process.env.TSAOT_DEBUG_UNSTABLE_CLASSES);
      for (let id = 0; id < this.classes.length; id++) {
        if (re.test(this.classes[id].name ?? "")) this.markUnstable(id, "debug-unstable-classes");
      }
    }
    return { classes: this.classes, symbolToId: this.bySymbol, nodeToId: this.byNode, closedReceivers };
  }
}
