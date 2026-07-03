# Scope resolution and identifier lookup — design

This is the foundational design for how tsaot resolves identifiers across the
full scope chain (local, captured, module, global built-ins). The current
implementation conflates these layers and uses text-pattern matching where
proper symbol-based resolution is required, which surfaces as several
correctness bugs (shadowing of `Math`, `console`, `Array`; silent miscompiles
of top-level statements; the not-yet-wired-up `LoadGlobal`/`StoreGlobal`
codegen).

Before changing any code, this document establishes:

1. The **canonical scope model** for tsaot (what scopes exist and how they
   nest).
2. The **identifier resolution algorithm** (how a bare identifier `x` finds
   its binding).
3. The **lowering strategy** for each scope kind (how a resolution becomes IR).
4. The **explicit non-goals** for v1 (what we're not modeling yet, and how we
   loud-reject them).

Implementation follows in a separate document and a separate change.

---

## 1. Targets and assumptions

- tsaot compiles a single `.ts` file as an **ES module**. CommonJS
  (`require`, `module.exports`, `exports.x`, `export =`,
  `import x = require()`) is NOT supported and is loud-rejected. See
  `module_linkage.md` and `export_value_sharing.md` §0 for the rationale.
  v1 is single-file (no `import`/`export` linkage at all); the in-file
  module-scope rules below apply regardless.
- The compiled program runs in an environment that provides JS built-ins
  (`console`, `Math`, `Array`, `Number`, `String`, `Object`, `Map`, `Set`,
  `Promise`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `NaN`, `Infinity`,
  `undefined`, `null`, `globalThis`, ...). tsaot supplies these as runtime C
  functions/objects.
- **Browser classic script** semantics (top-level `var` becoming a `window`
  property) are **out of scope**. tsaot's V8 reference currently uses
  `ts.transpileModule({module: CommonJS})`, which for single-file
  import-free code is byte-identical to ESM output (verified); when import
  tests are added the oracle switches to `module: ESNext`.

---

## 2. The scope model

tsaot adopts the following scope hierarchy. Inner scopes search outward.

```
┌────────────────────────────────────────────────────────────┐
│ Global scope (read-only, runtime-provided)                 │
│   console, Math, Array, Number, String, Object, Boolean,   │
│   Map, Set, Promise, Date, JSON, RegExp,                   │
│   parseInt, parseFloat, isNaN, isFinite,                   │
│   NaN, Infinity, undefined, null, globalThis               │
│   ────────────────────────────────────────────────────     │
│   Bindings provided by `lib.*.d.ts`. The user cannot       │
│   declare them at this level; they CAN be shadowed by any  │
│   inner declaration of the same name.                      │
├────────────────────────────────────────────────────────────┤
│ Module scope                                               │
│   top-level `var`, `let`, `const`, `function`, `class`,    │
│   `enum`, `type`, `interface`                              │
│   ────────────────────────────────────────────────────     │
│   Created by the source file. Not accessible via           │
│   `globalThis` (matches ESM, NOT browser classic script).  │
│   `var`/`function` hoist; `let`/`const`/`class` have TDZ.  │
├────────────────────────────────────────────────────────────┤
│ Function scope(s) ... (nested function/method/arrow)       │
│   parameters, local `var`/`let`/`const`, nested funcs      │
│   ────────────────────────────────────────────────────     │
│   Each function introduces its own scope. Inner scopes     │
│   reference outer-scope bindings via closure capture.      │
├────────────────────────────────────────────────────────────┤
│ Class scope ⋯ (inside `class Body { ... }`)                │
│   the class's own name, type parameters, plus              │
│   *private* names `#x` / `#m()` from `private declarations`│
│   ────────────────────────────────────────────────────     │
│   Lives between the method/field-initializer scopes and    │
│   the enclosing function/module. Public field/method names │
│   are NOT scope bindings (they're properties of `this`).   │
│   Private names ARE scope bindings — lexically bound to    │
│   the class body, brand-checked at access time.            │
├────────────────────────────────────────────────────────────┤
│ Block scope(s) ⋯ (inside `{ ... }`, for/while/if/try)      │
│   block-local `let`/`const`/`class`                        │
└────────────────────────────────────────────────────────────┘
```

The chain when resolving a bare identifier from inside a class method:

```
block → ... → method-function → class scope → outer function(s) → module → global
```

Note: a method body is *both* a function scope (for `let`/`const`/parameters)
*and* lives inside a class scope (for private names + the class's own name).
The two layers are distinct.

### 2.1 Distinct scope kinds tsaot must distinguish

| Scope kind        | Created by                                | Bindings  | tsaot representation                       |
| ----------------- | ----------------------------------------- | --------- | ------------------------------------------ |
| Global (built-ins)| Runtime / `lib.*.d.ts`                    | ro        | static dispatch via builtin names          |
| Module            | The source file                           | rw        | locals of synthetic `__module_init`        |
| Function          | Function/method/arrow                     | rw        | function locals (`v0`, `d0`, ...)          |
| Class             | `class C { ... }`                         | rw        | (class name → fnId/classId via classSymToId; private names → per-class private table; see §2.5–2.6) |
| Block             | `{}`, `for`/`while`/`if`/`try` blocks     | rw        | function locals + lifetime via fresh slot  |

Note: tsaot's IR does not have block-scoped locals as a first-class concept
today. Block-level `let`/`const` are lowered as function locals, with the
type checker preventing illegal access patterns at lowering time. This is
sound because TypeScript's checker rejects ill-formed access at compile time.

### 2.2 Module scope is local to `__module_init` from tsaot's perspective

The conceptual model **and** the implementation model agree:

- Module scope is **semantically** a scope that lives for the lifetime of
  the program.
- Operationally, tsaot models it as the locals of a synthetic function
  `__module_init`, which is called once at program startup.
- Nested functions (including the user's `main`, top-level
  `function`/`class` declarations) capture module-scope bindings the same
  way they capture any outer-function local: via the existing closure /
  cell mechanism.

This means that for v1, **module-scoped bindings do NOT use the
`LoadGlobal` / `StoreGlobal` IR**. They go through cells. But that does
NOT mean the IR opcodes go away: `LoadGlobal` / `StoreGlobal` and the
underlying `GlobalEnvironment` model **stay in the IR** as
infrastructure for things that genuinely belong to the global
environment record. v1 has no producers, but the slots reserved for
future features include:

- `globalThis.x = value` (ESM permits writes to globalThis even
  though top-level `let x` does not show up there). Future support for
  `globalThis` would emit `StoreGlobal`/`LoadGlobal` with the user's
  name.
- A future browser-classic-script compilation mode where top-level
  `var` and `function` declarations genuinely land on `globalThis`.
- User-provided global injection (host-supplied globals that the
  runtime registers before user code runs).

So the design separates two things that the earlier draft confused:
- **Module bindings**: not in GlobalEnvironment, go through cells (this
  document).
- **The GlobalEnvironment itself**: exists in the IR, currently has no
  producers, codegen wires through to the `GLOBALS[]` array. Kept as
  infrastructure for future features.

### 2.3 Hoisting and TDZ — how this fits

JS distinguishes:

- **`var` / `function`**: hoisted to the enclosing function scope. Reading
  `var x` before its initializer runs yields `undefined`. Calling a hoisted
  `function foo` before its textual position works.
- **`let` / `const` / `class`**: hoisted as bindings (the binding "exists"
  in the scope from the top), but reading them before their initializer
  position is a TDZ ReferenceError.

In tsaot:

- **Function hoisting**: handled at lowering time. We collect all top-level
  function declarations BEFORE lowering top-level statements, so they're
  available throughout `__module_init`'s body (and in any nested function
  that captures them). The same applies inside nested functions: function
  declarations inside `function f() { ... function g() { ... } ... g(); }`
  must be reachable at the textually-prior call site.
- **`var` hoisting**: top-level `var x = init` is lowered as
  (a) a `var x = undefined` slot at the top of `__module_init` plus
  (b) a `Copy x ← init` at the textual position. Same for nested
  function-scoped `var`.
- **`let` / `const` TDZ**: rather than a runtime TDZ check (which the IR
  doesn't model), tsaot **rejects TDZ violations at lowering time**:
  an identifier reference to a `let`/`const` binding that appears
  textually before the declaration is a `unsupported` (loud reject). The
  TypeScript checker generally rejects these at type-check time, so
  in practice this is rarely user-visible.

### 2.4 Shadowing — the central correctness property

Every scope can shadow names from outer scopes. The current bugs (`const
Math = ...` not shadowing the built-in, `const console = ...` not
shadowing) all stem from violating this property. The fix is structural:
**identifier resolution must use the TypeScript checker's symbol resolution,
not source-text matching, to decide whether `Math` refers to the built-in
or a user binding.**

### 2.5 Class scope

A `class C { ... }` introduces a scope that sits **between** the method/
field-initializer scopes and the enclosing function/module scope. The class
scope is invisible to the runtime in the same sense that a function scope is
— but it has its own bindings and its own rules. Failing to model it as a
distinct layer was the root cause of the historical `class A { a = 1 }`
bug and is the reason `#private` "works by accident" today.

**What lives in class scope:**

1. **The class's own name** (`C` itself), visible inside the class body —
   this is why a method can write `new C()` or `C.staticMethod()` without
   referring to the outer binding of `C`. Also covers class expressions:
   `const X = class C { foo() { return C; } }` — `C` is only visible
   inside the class body, NOT outside.

2. **Type parameters** (`class Box<T> { ... }`): the type parameter `T` is
   a class-scope binding visible to methods and field declarations. In
   tsaot these are erased at compile time and don't affect lowering, but
   they're part of the conceptual scope.

3. **Private names** `#x`, `#m`: see §2.6.

**What does NOT live in class scope** (a common confusion):

- Public field names (`a` in `class C { a = 1; }`) are NOT scope bindings.
  They're properties of class instances, accessed via `this.a` from
  methods. A bare `a` inside a method does NOT resolve to the field; it
  looks up the enclosing function/module/global scope. **This is the
  cause of the `class A { a = 1; foo() { return a; } }` bug**: the bare
  `a` inside `foo` resolves to whatever `a` is in the outer scope, NOT to
  `this.a`. The TypeScript checker correctly rejects this as `Cannot find
  name 'a'` unless an outer `a` exists; tsaot must mirror that judgment.

- Public method names: same thing. `class C { foo() {} bar() { foo(); } }`
  is incorrect; the call inside `bar` should be `this.foo()`. The TS
  checker rejects it.

- Constructor parameters: scoped to the constructor function, not the
  class.

So most identifier resolution inside a method body **skips class scope**
and walks directly to the enclosing function/module/global scope. Only
two kinds of references hit class scope: (a) the class's own name `C`,
which the TypeScript checker resolves to the class's symbol; and (b)
private names `#x`, which we discuss separately.

**Field declarations and field-initializer scope** are subtle:

```ts
const X = 10;
class Box {
  v = X + 1;         // initializer is evaluated in a per-instance context
  static N = X * 2;  // initializer is evaluated at class-definition time
}
```

The field initializer `X + 1` is conceptually an expression executed at
**constructor entry** (for instance fields) or at **class-definition
time** (for static fields). It sees:
- `this` bound to the new instance (for instance fields). `this` is NOT
  available in static field initializers; per spec, static initializers
  see `this === C`.
- The class's own name `C` (and `#private` names of this class).
- The enclosing function/module/global scope.

In tsaot's current implementation, instance field initializers are
emitted as part of the constructor body (good — matches the spec). But
the question of **what scope they live in** wasn't precisely defined,
which is partly why the `class A { a = 1; foo() { return a; } }` bug
hung around: the lowering treated the initializer's environment as
either too permissive or too restrictive in different code paths.

### 2.6 Private names (`#x`, `#method()`)

`#name` is a different kind of identifier than `name`. In JS/TS:

- `#name` is a **PrivateIdentifier** at parse time (a distinct AST node
  kind, NOT an Identifier). The TypeScript checker only resolves
  `#name` references inside the class body where `#name` is declared.
  Outside that class body, `#name` is a syntax error.
- A `#name` declaration creates a **lexical binding scoped to the entire
  class body** — visible to every method, accessor, and field
  initializer of *that specific class*. NOT inherited by subclasses
  (each subclass declares its own private names).
- Access to `obj.#name` requires `obj` to be an instance of the class
  that declares `#name`. This is the **brand check**: `obj instanceof
  ThisClass` semantics, enforced at runtime in real JS (throws
  TypeError otherwise). The `#name in obj` expression performs the
  brand check explicitly.
- `#name` is NOT a string. `obj["#name"]` is unrelated to `obj.#name`.
  Two classes that each declare `#x` have **two different `#x`
  bindings** that happen to share textual spelling but are distinct
  identities — much like two functions can each declare `let x` and
  those are different bindings.

**The implication for tsaot:**

The current approach (intern `#v` as the literal field name `"#v"`) is
wrong even where it appears to work:

| Scenario                                | Today's behavior                          | Correct behavior                              |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `class A { #x; } class B { #x; }`       | Both use field name `"#x"`. Works by      | Each class has its own `#x` binding.          |
|                                         | luck: different instances, no collision.  | tsaot must give them distinct field ids.      |
| `new A()["#x"]` from outside the class  | Reads the field (returns the value)       | `undefined` (the literal string is not        |
|                                         |                                           | the same as the `#x` private name)            |
| `#x in obj` brand check                 | Loud-reject: PrivateIdentifier in `in`    | Must work: returns true iff obj has the       |
|                                         | expression unsupported                    | `#x` brand for THIS class                     |
| `class C { #m() { ... } }`              | Method registration skips PrivateIdentifier;| `#m` is a per-class private method binding.   |
|                                         | `this.#m()` segfaults                     |                                                |
| `class C { static #N = 1; }`            | Returns NaN (static private field         | Static private field is a class-scope binding |
|                                         | init not run)                             | initialized at class definition time          |

The fix is to give private names their own representation in tsaot's IR,
NOT to keep treating them as funny strings.

**Design for private names in tsaot:**

A private name is identified by the pair **(class id, private spelling)**.
Two `#x` declared in `class A` and `class B` get different identities;
references in `A`'s methods to `#x` resolve to A's binding, references
in `B`'s methods to B's binding. The TypeScript checker already does
this resolution — `checker.getSymbolAtLocation(privateIdNode)` returns
the symbol whose declaring class is the right one. tsaot maps each
private-name symbol to a fresh **private field id** that is unique
across the program (not shared between classes even if they spell `#x`
the same).

```
privateFieldIdOf : Map<ts.Symbol, FieldId>
```

The first time we see a private-name declaration symbol, we allocate a
new FieldId for it via `internField`. Subsequent references use the
same FieldId. Because we go through the symbol, two `#x` in different
classes get DIFFERENT FieldIds, even though the user-visible spelling
is the same. (Internally the field name is something like `"#x@A"` for
display purposes only.)

- **Instance private field**: a property of the instance, accessed via
  `LoadField/StoreField` with the private FieldId. The brand check is
  satisfied because only methods of class `A` ever emit code that uses
  A's private FieldIds. (TypeScript prevents anyone else from referring
  to `#x` by name.)
- **Private method**: registered as a class method, but its key is the
  private FieldId rather than a normal METHOD_KEY. Method invocation
  `this.#m()` becomes a direct call to the registered method.
- **Static private field**: a property of the class's **constructor
  function object** (`C` itself, not `C.prototype` and not any
  instance). Static initializers store into the class-level container
  at class-definition time. `C.#N` reads from that container.
- **`#name in obj` (brand check)**: lowered to a runtime check
  `ts_has_field(obj, FieldId)` — returns true iff obj's prop map / typed
  field set contains the FieldId. Since the FieldId is unique to this
  class's `#name`, this gives the correct brand semantics for free.

**Inheritance**: private names are NOT inherited. A subclass `class
SubA extends A { #x; }` declares its OWN `#x`, distinct from A's `#x`.
SubA instances have BOTH brands. tsaot's symbol-based mapping handles
this without special cases: `SubA`'s `#x` symbol is distinct from `A`'s
`#x` symbol, so they map to different FieldIds.

**Class expressions and the class's own name**: `const F = class C {
foo() { return new C(); } }` works because `C` inside the body resolves
to the class. tsaot already handles this for class declarations via
`classSymToId`; class expressions need the same treatment, which is
mostly there.

---

## 3. Identifier resolution algorithm

Given a bare identifier `id` appearing in some context:

```
1. Let `sym = checker.getSymbolAtLocation(id)`.
2. If `sym` is undefined, the identifier is undeclared.
   → Loud-reject (the TS checker would also fail).
3. Determine `sym`'s declaration site by inspecting `sym.valueDeclaration
   ?? sym.declarations[0]` and its containing source file.
4. Classify by declaration site:

   (a) Declaration's file is a `lib.*.d.ts` (TypeScript's stdlib for
       JS built-ins): this is a GLOBAL BUILT-IN identifier.
       → Dispatch to the appropriate tsaot built-in lowering:
          - `console` → set up to handle `console.log(...)` etc.
          - `Math`    → dispatch property accesses via namespace builtin map
          - `Array`, `Object`, `Number`, `String`, `Boolean`: constructors,
            handle `new` / coercion / static methods.
          - `Map`, `Set`, `Promise`, `Date`, `JSON`, `RegExp`, `Symbol`,
            `globalThis`: per-name handling (some may be loud-reject for v1).
          - bare functions: `parseInt`, `parseFloat`, `isNaN`, `isFinite`,
            `fetch`.
          - bare values: `NaN`, `Infinity`, `undefined` → constants.

   (b) Declaration is a `FunctionDeclaration` whose parent is the source
       file (module scope), and `sym` is in `funcSymbols`: this is a MODULE
       FUNCTION. Read as a value → emit AllocClosure (existing path).
       Called → emit Call with Direct callee (existing path).

   (c) Declaration is a `ClassDeclaration` whose parent is the source file:
       this is a MODULE CLASS. (Existing path: `new X(...)` resolves via
       classSymToId.) The same case applies when an identifier inside the
       class body refers to the class itself — the symbol resolves to the
       class binding, and the lowering uses classSymToId. For class
       *expressions* `const F = class C { ... use C ... }`, the binding
       `C` is visible only inside the body; it is in the class scope, and
       its symbol's only declaration is the class expression itself.
       Resolution still goes through classSymToId, registered when the
       class expression is encountered.

   (d) Declaration is inside the current function (parameter, local var/let/
       const, nested function declaration): this is a LOCAL.
       → Resolve via ctx.localOfSymbol or ensure a new local.

   (e) Declaration is in an outer function (between current and module):
       this is a CAPTURED FREE VARIABLE.
       → The free-variable pre-pass has already added `sym` to cellBindings;
         the outer function allocates a cell, the inner function captures
         it. Read/write becomes LoadField/StoreField on the cell.
         (Existing closure machinery.)

   (f) Declaration is at module scope (top-level var/let/const): MODULE-
       SCOPED BINDING.
       → Conceptually, this is a free variable of every nested function
         that uses it. After this design lands, module-scoped bindings are
         physically locals of `__module_init`. References from
         `__module_init`'s own body are plain locals. References from any
         nested function go through the same cell mechanism as (e).
         The user's `main`, top-level `function foo`, etc. are themselves
         nested under `__module_init` and capture module bindings as cells.

   (g) Declaration is an `ImportSpecifier` / `ImportClause` /
       `NamespaceImport` in the current source file: this is an IMPORTED
       BINDING from another module. **v1 LOUD-REJECTS** at the import
       statement, so this case is never actually reached for value
       imports (a reachable identifier whose symbol points to an import
       is impossible if the import itself was rejected). v2 represents
       these as `Binding` records with `BindingKind::ImportRef { from_module,
       from_binding }`; reads are lowered via `Inst::LoadImport` (an
       indirection through the live cell owned by the exporting module);
       writes are statically rejected by the exporter (spec mandates
       importer-side const-like behavior). See `export_value_sharing.md`
       for the full design including the Ref-type representation,
       namespace imports (AllocNamespace). CommonJS is not supported.
       Type-only imports (`import type { X }`) are erased at lowering
       time and never produce a runtime identifier reference, so this
       case doesn't apply to them either.
```

### 3.0.1 PrivateIdentifier (`#name`) resolution

PrivateIdentifier is a syntactically distinct node from Identifier. It can
only appear in three contexts (the TypeScript parser already enforces
this):

- The member name in a class field/method/accessor declaration:
  `class C { #x = 1; #m() {} get #y() {} }`
- The property name of a property-access expression:
  `this.#x`, `other.#x`, `C.#staticPriv`
- The left-hand side of an `in` expression:
  `#x in obj` (brand check)

The resolution algorithm for a PrivateIdentifier node `#name`:

```
1. Let `sym = checker.getSymbolAtLocation(#name)`.
2. If `sym` is undefined, the TS checker has rejected this (private name
   not in scope). tsaot reports an exporter error.
3. Look up `sym` in `privateFieldIdOf`. If not present, allocate a fresh
   FieldId via `internField` with a display name like `#name@<className>`
   and record it.
4. The result is a FieldId, used by the caller as follows:
   - In a member declaration: the FieldId is the field/method key for
     the lowered class.
   - In `obj.#name`: emit `LoadField/StoreField obj FieldId`.
   - In `#name in obj`: emit `HasField obj FieldId` (a new IR op for
     brand-check semantics).
```

Note: the **TypeScript checker is the source of truth** for which class a
given `#name` belongs to. Two `#x` in two different classes have
different symbols, so step 3 allocates different FieldIds. The exporter
never has to track "which class is this private reference for" — the
checker has already done that work.

### 3.1 Property access `obj.member`

Distinct from bare identifier resolution. The receiver `obj` is resolved
first by (3) above. THEN the `.member` is dispatched:

- If `member` is a **PrivateIdentifier** (`obj.#x`): apply §3.0.1 to
  obtain the FieldId, then emit `LoadField/StoreField`. The brand check
  is implicit — the FieldId is unique to the declaring class, so only
  instances that have been assigned to from a method of that class will
  have the field set.
- If `obj` resolved to a global built-in namespace (e.g. `Math`, `Object`,
  `Number`, `String`, `JSON`, `console`): dispatch `.member` statically
  through the existing `namespaceBuiltin` map. **Crucially, this dispatch
  happens only when (3) classified `obj` as a built-in.** If the user
  wrote `const Math = { sqrt: ... }`, (3) classifies `Math` as a local
  (case (d)), and `.sqrt(4)` becomes a normal LoadField + Call — no
  static built-in dispatch.
- If `obj` resolved to a value of a built-in type (string, array, map, set,
  number): dispatch instance methods via `builtinReceiverKind` and
  `builtinMethodName2` (existing path). This is **per-value type**, not
  per-identifier-text, so shadowing already works at this layer.
- Otherwise: a normal LoadField / dynamic method call.

### 3.2 Bare call `id(args)` versus `obj.id(args)`

Both go through (3) for the function reference. For built-in identifiers
acting as constructors (`Array(...)`, `Number(...)`, `Boolean(...)`,
`String(...)`), the call-site lowering inspects the resolved kind:

- `id` is a built-in constructor symbol → emit a coerce / construct
  builtin (existing path, but only when symbol-resolved to the built-in).
- `id` is a user function (case (b)/(d)/(e)/(f)) → ordinary call.

---

## 4. The classification primitive: `isBuiltinSymbol(sym)`

Every text-based comparison in the exporter is replaced by a call to a
single helper:

```ts
isBuiltinSymbol(sym: ts.Symbol | undefined): { name: string } | undefined {
  if (!sym) return undefined;
  const d = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!d) return undefined;
  const sf = d.getSourceFile();
  // TypeScript's built-in libraries live under the typescript package, with
  // filenames matching /lib\.[a-z0-9_.]+\.d\.ts$/. Anything from these is a
  // declaration of a global built-in.
  if (!/^lib\.[a-z0-9_.]+\.d\.ts$/.test(this.basename(sf.fileName))) return undefined;
  return { name: sym.name };
}
```

This is the **only place** identifier classification happens. Every existing
text-pattern check (`fn.text === "Math"`, `fn.expression.text === "console"`,
etc.) becomes:

```ts
const recv = /* expression node */;
const sym = ts.isIdentifier(recv) ? this.symbolOf(recv) : undefined;
const builtin = this.isBuiltinSymbol(sym);
if (builtin?.name === "Math") { /* handle Math.* */ }
```

When the user writes `const Math = ...`, `sym` resolves to the local
declaration whose source file is the user's `.ts` file, `isBuiltinSymbol`
returns undefined, and the namespace dispatch is skipped — falling through
to a normal property access lowering.

### 4.1 What "the lib file" means precisely

TypeScript's stdlib declarations live in files like:
- `lib.es5.d.ts` (Math, Array, Object, Number, String, Date, RegExp, ...)
- `lib.es2015.core.d.ts`, `lib.es2015.collection.d.ts` (Map, Set, ...)
- `lib.es2015.promise.d.ts` (Promise)
- `lib.es2015.symbol.d.ts` (Symbol)
- `lib.dom.d.ts` (console, fetch, ...)
- `lib.dom.iterable.d.ts`
- `lib.scripthost.d.ts`
- `lib.webworker.d.ts`
- `lib.esnext.d.ts`

The pattern `lib.*.d.ts` (basename-only) matches all of them and ONLY them
in TypeScript's installation. We do NOT need to enumerate per-file; the
naming convention is stable. The user can in principle ship a file
literally named `lib.foo.d.ts`, but it's such an edge case that we accept it
as input ambiguity.

### 4.2 Multiple declarations: `interface Math { ... }` augmentations

Some user code augments built-in interfaces, e.g.

```ts
interface Array<T> { myMethod(): void }
```

The symbol's `declarations` array then contains BOTH the lib declaration AND
the user augmentation. `isBuiltinSymbol` should return "is built-in" if
**any** declaration is in a lib file. This is correct: the binding is still
the global Array; the user merely extended its interface. The method
dispatch for `myMethod` becomes dynamic (no built-in mapping), which is
fine — we'd fall through to the normal LoadField + Call path.

---

## 5. Lowering strategy for each scope kind

### 5.1 Global built-ins (case 4a)

Static dispatch via the existing builtin tables. No runtime storage.
Identifier-as-value (e.g. passing `Math` to a function) is **loud reject** for
v1 (Math is not a first-class value in our model). Identifier-as-callee
(`Array(...)`, `Number(...)`) and namespace-property access (`Math.sqrt(...)`,
`console.log(...)`) follow existing builtin paths.

`undefined`, `NaN`, `Infinity`, `null` are special: they're constant values,
lowered as `Const` IR.

### 5.2 Module bindings (cases 4f)

Module bindings live as locals in `__module_init`. References from
`__module_init`'s body are plain local accesses (Copy / direct read). From
nested functions, they're free variables and use the existing cell
mechanism.

Concretely, when `lowerSourceFile` runs:

1. Collect all module bindings (`var x`, `let y`, `const z`, `function f`,
   `class C` at top level).
2. Free-variable pre-pass: any nested function that references one of
   these has the symbol added to `cellBindings`. (Free-var pre-pass already
   exists for inter-function free vars; we extend it to walk the entire
   module body.)
3. Synthesize `__module_init` whose body holds the top-level statements
   (excluding type-only declarations and import/export which we don't
   support).
4. Lower `__module_init` first. Its prologue allocates cells for any
   module bindings that nested functions capture (re-using the existing
   prologue cell-alloc pass).
5. Lower each nested function (user `main`, top-level `function foo`,
   class methods). Their references to module bindings go through cell
   LoadField/StoreField — the same mechanism as `function compose(f, g) {
   return x => f(g(x)); }`.

The runtime entry then calls `__module_init` (which runs all top-level
statements in source order). It does NOT auto-call `main`. If the user
wants `main` to run, they call it themselves from top level (`main();`).
See §7 for the full lifecycle.

### 5.3 Function locals (case 4d)

Unchanged from today. `ensureLocal(sym)` returns the function's local
binding for the symbol.

### 5.4 Captured free variables (case 4e)

Unchanged from today. The free-variable pre-pass marks captured symbols;
the enclosing function allocates a cell; the inner function captures it.

### 5.5 Function declarations as values (case 4b)

Unchanged from today: AllocClosure with no captures.

### 5.6 Class declarations as values (case 4c)

`new C(...)` goes through the existing class instantiation path. `C` as a
value (passed to a function, stored in a variable) is partially supported
today via the same AllocClosure mechanism (a class's constructor is just a
function from tsaot's perspective). No change for now.

### 5.7 Class scope (the class's own name, fields, methods)

When tsaot encounters `class C { ... }`:

1. Allocate a `classId` and register `csym → classId` in `classSymToId`
   (existing). The class's own name `C` referenced inside its body
   resolves to this classId.
2. For class *expressions* `const F = class C { ... }`, the binding `C`
   is visible only inside the body. Today the same registration is
   skipped for class expressions; this must be fixed so the body can
   refer to itself.
3. Walk the class members ONCE in source order, producing:
   - **For each public PropertyDeclaration `name = init`**: record that
     the class has an instance field named `name` with an initializer
     `init`. Initializer lowering is deferred to constructor body
     emission (§5.7.1).
   - **For each public PropertyDeclaration `static name = init`**:
     record that the class has a static field. Initialization happens
     at class-definition time (§5.7.2).
   - **For each public MethodDeclaration `m() {}`** (and getter/setter,
     and constructor): assign fnId, record `methodFunc[classId:method:name]`,
     lower the body in a later pass. (Existing.)
   - **For each PRIVATE member** (PropertyDeclaration or MethodDeclaration
     with PrivateIdentifier name): see §5.8.
4. Build the class table entry: ownFields, methods, parent class id, etc.
   (Existing buildClassesTable path, with private members extending the
   structures it produces.)

#### 5.7.1 Instance field initializer scope

A `class C { v = E }` field initializer `E` runs **at constructor entry,
AFTER super() returns** (per spec — fields are initialized after the
parent has fully constructed). For tsaot:

- The initializer `E` is lowered into the constructor body, immediately
  after super() (if a parent class exists) and before any user
  constructor body. (Existing path: emitFieldInitializers.)
- Inside the initializer, `this` is bound to the new instance (the
  constructor's `this`). The TypeScript checker types the initializer
  accordingly.
- The initializer's enclosing scope is the **method body of the
  synthetic constructor**, which means: it has access to constructor
  parameters (if invoked via the user constructor; for the implicit
  default-constructor case, there are no params), the class scope (own
  name + private names), and the enclosing module/global scope.
- A bare identifier `a` inside `v = a + 1` resolves via the §3 algorithm.
  If there's no `a` in any outer scope, the checker errors out —
  matching JS semantics. tsaot does NOT silently turn `a` into
  `this.a` (that bug is what bit us before).

#### 5.7.2 Static members: fields, methods, and blocks

`class C` may declare three kinds of static members:

```ts
class C {
  static A: number = 1;          // (a) static field
  static greet(): string {...}   // (b) static method
  static { C.B = compute(); }    // (c) static block
}
```

Current tsaot status (probed empirically before writing this section):

| Form                                | tsaot today | V8     | Comment                              |
| ----------------------------------- | ----------- | ------ | ------------------------------------ |
| `static greet()` (b)                | OK          | OK     | Existing static-method path works    |
| `static N = 42` (a)                 | **NaN**     | 42     | Static field initializer never runs  |
| `static {...}` block (c)            | **NaN**     | varies | Static block syntax not handled      |
| `static B = C.A + 10` (a chained)   | **NaN**     | 11     | Init order across statics broken     |
| `static block` references module    | **NaN**     | works  | Static-init scope broken             |
| `C.method()` from another `C.m()`   | OK          | OK     | Dynamic dispatch through C's protos  |

So the design has to: (1) implement static field initialization properly,
(2) implement static blocks, and (3) make the two compose with the right
initialization order. Static methods already work and stay the same.

##### Storage

Statics live on the **class itself** (`C`), conceptually on the
constructor function object. tsaot already stores public statics on a
per-class container today (this is what makes `C.greet` work for static
methods — they're registered on the class object's property map). Static
fields use the same container under the same field ids that public
instance fields use, plus a flag for "this is on the class, not the
instance". Static private fields use the private FieldId on the same
class container (§5.8).

There is **no per-instance allocation** for any static — they're all
slots on `C`.

##### Initialization model: `__static_init_<classId>`

For each class with at least one static field or static block, the
exporter synthesizes a function `__static_init_<classId>(C)` whose body
is the **concatenation of all static initializations in source order**.
Source order matters because static fields may reference earlier
statics:

```ts
class C {
  static A: number = 1;
  static B: number = C.A + 10;   // sees A as 1 ✓
}
```

The synthesized function takes the class object `C` as its parameter
(so `this` inside the body is `C`, per spec). Its body, in source order:

- For a `static F: T = E;` declaration: emit `StoreField C, FieldId, E`
  (where E is the lowered initializer expression).
- For a `static F: T;` declaration (no initializer): emit nothing
  (slot stays `undefined`; same as instance fields).
- For a `static { ...body... }` block: lower the block's statements
  directly in place. The block's `this` is `C`. Any `let`/`const` inside
  the block are block-locals of `__static_init_<classId>`.

The result: a single function per class, with all static-side-effecting
operations in source order, with `this` and the class binding `C` in
scope.

##### When does `__static_init_<classId>` run?

At class registration time, called from the generated entry routine
**before any user code runs**. The order across classes is the source
order in which classes are declared at module top level. This matches
JS semantics: a class declaration with static initializers runs them
when the class is created (top-down through the file).

Concretely, the runtime entry sequence becomes:

```c
int main(void) {
  ts_init_fields(...);
  ts_setup_object_proto();
  // ... existing prototype setup ...
  ts_register_classes();          // registers class structures, methods
  __static_init_0(CLASS_OBJ[0]);  // run static initializers of first class
  __static_init_2(CLASS_OBJ[2]);  // ... of any other class with statics
  // ...
  __module_init();                // run top-level statements
  ts_run_event_loop();
  return 0;
}
```

The static init calls happen between class registration and module init.
This is observationally indistinguishable from the JS model: in JS, the
class declaration is itself a top-level statement that creates the class
AND runs its static initializers in one step. Splitting it into two
calls just makes implementation cleaner.

For a class declared INSIDE a function (e.g. `function f() { class
Inner { static N = 1; } }`), `__static_init_<classId>` runs each time
`f` is called — the class is re-created each call. tsaot handles
this by emitting a class-allocation + static-init call inline at the
class declaration's location inside the enclosing function.

##### Scope rules for `__static_init_<classId>`

Inside the body:

- `this` is bound to `C` (the class). The exporter sets `ctx.thisLocal`
  to the class parameter for the duration of static-init lowering.
- The class's own name `C` is in scope (case 4c).
- Private names `#x` (declared as `static #x`) resolve via §5.8.
- Any module-level binding the body references becomes a free variable;
  the cell mechanism handles it like any other capturing function.

For example:

```ts
const FACTOR = 7;
class C {
  static N = FACTOR * 6;   // captures FACTOR
}
```

`FACTOR` is module-scope. The synthesized `__static_init_<classId>` is
just another nested function of `__module_init`. The free-var pre-pass
adds FACTOR to `cellBindings`. `__module_init` allocates a cell for
FACTOR with the initializer `7`; `__static_init_<classId>` captures the
cell; reading FACTOR is LoadField on the cell. **No new mechanism —
the existing closure machinery does the job.**

##### Static blocks specifically

`static { ... }` syntax (ES2022). The block is lowered exactly like the
body of any function: a sequence of statements, each lowered via
`lowerStmt`. The block introduces a function-like scope, so:

- `let`/`const` declarations inside the block are block-local; they do
  NOT leak to subsequent static initializers in the same class.
- `return` inside a static block is a syntax error (TS checker rejects).
- `await` inside a static block: TS allows it in async contexts, but
  tsaot rejects it (loud) for v1 — async at class definition time
  introduces complexity we don't need yet.
- Multiple static blocks in one class are concatenated in source order
  with the static fields, all into the same `__static_init_<classId>`.

##### Static methods (already working)

No change. Static methods are stored on the class object via the
existing path. Calling `C.method(args)` resolves `C` to the class
binding, then dispatches `.method` as a normal property access on the
class. The instance/static distinction is purely about which container
the property lives on — instance methods on the prototype, static
methods on the class itself.

The only refinement needed: when a static method body references the
class's own name (`C.helper(x)` from inside `static compute()`), the
identifier `C` must resolve correctly. The TypeScript checker already
gives the right symbol; resolution falls through to case 4c (module
class). Already works.

##### `this` in static methods

Per spec, `this` inside a static method refers to the **class**, not
an instance. So `static compute() { return this.helper(0); }` is
equivalent to `static compute() { return C.helper(0); }`. tsaot today
treats `this` in static methods as the method's first argument (the
recv slot), which the call site populates with `C`. That matches the
spec.

#### 5.7.3 Method body scope

A method body's lexical scope is:

```
method body → method-function locals → class scope → enclosing function/module → global
```

In tsaot today this is mostly correct, with one nuance: when a method
references a private name `#x`, the lookup hits class scope (§3.0.1).
The exporter must NOT treat `#x` as a free variable; it's NOT captured
via cell — it's a class-scope binding resolved to a FieldId.

### 5.8 Private names

Two data structures are added:

```
privateFieldIdOf : Map<ts.Symbol, FieldId>   // each #name symbol → fresh FieldId
privateMembersOf : Map<classId, Array<{
  spelling: string,
  fieldId: FieldId,
  kind: "field" | "method" | "getter" | "setter",
  isStatic: boolean,
  funcId?: fnId,          // for methods/accessors
  initializerNode?: Node, // for fields, lowered into constructor / static init
}>>
```

Lowering rules:

- **Private field declaration** `#x = E` or `#x;`:
  - Allocate a FieldId via privateFieldIdOf (key: the field's symbol).
  - Add to privateMembersOf[classId] with isStatic and initializerNode.
  - Instance private field: emitFieldInitializers lowers `this.<FieldId>
    = E`. With no initializer, the slot is `undefined` — same as a
    public uninitialized field.
  - Static private field: lowered into `__static_init_<classId>` which
    stores into the class's static container at the FieldId.

- **Private method declaration** `#m() { body }` or `#m()` (no body —
  in TS this is only valid in abstract classes, which tsaot does not
  support; loud-reject):
  - Allocate a FieldId for the method's symbol.
  - Assign a fnId for the body (same as a public method).
  - Add to privateMembersOf and to the class table's method list under
    the private FieldId key.
  - The method is registered on the class's prototype using the private
    FieldId (so dispatch from `this.#m()` finds it via the same
    LoadField/Call path as a public method, but with the private
    FieldId).

- **Private member access** `obj.#name`:
  - PrivateIdentifier resolution (§3.0.1) yields a FieldId.
  - Emit `LoadField/StoreField obj FieldId`. No special case beyond the
    FieldId being chosen from privateFieldIdOf rather than internField.

- **Private method call** `this.#m(args)`:
  - Receiver `this` → known to be an instance of this class.
  - `.#m` PrivateIdentifier → FieldId via privateFieldIdOf.
  - Emit `Call recv=this, args=[...], callee=Direct{funcId}` using the
    fnId from privateMembersOf, OR a method dispatch (`LoadField` then
    `Call Value`) if static analysis can't pin the receiver class.
    The latter handles polymorphic cases where `obj.#m()` is called on
    an unknown subclass — though by the brand-check rule, the unknown
    subclass either has `#m` (with its own FieldId, different from
    the current one — would be a TS error) or doesn't (also TS error).
    In practice, Direct call is correct for non-virtual private methods.

- **Brand check** `#name in obj`:
  - PrivateIdentifier resolution yields FieldId.
  - Emit `HasField obj FieldId` — a NEW IR opcode returning a boolean.
  - Runtime: `ts_has_field(obj, FieldId)` checks the prop map / typed
    field bitmap for the given FieldId.

- **Static private access** `C.#N`:
  - Receiver `C` → resolves to the class binding (case 4c).
  - `.#N` PrivateIdentifier → FieldId.
  - Emit a static read from the class's static container at FieldId.
  - This requires runtime support for per-class static storage. The
    existing implementation uses the constructor function object's prop
    map for public statics (`C.publicStatic = ...`); private statics
    extend that mechanism by using the private FieldId.

#### 5.8.1 Inheritance and private names

Subclass `class B extends A { #x; }` declares its own `#x`. This `#x`
is a DIFFERENT symbol from `A`'s `#x` (the TypeScript checker resolves
each within its declaring class). privateFieldIdOf assigns different
FieldIds. A `B` instance has two slots: the inherited (whatever A
stored via its `#x` FieldId) and B's own `#x`. Both coexist; neither
shadows the other in the field-storage sense.

#### 5.8.2 Private name in field initializer of the same class

```ts
class C {
  #x = 1;
  y = this.#x + 1;
}
```

The initializer of `y` runs after `#x`'s initializer (source order, per
spec). At the time `y`'s initializer runs, `this.#x` is set. Lowering
emits the initializers in source order in the constructor body —
existing behavior already does this. The only addition is that `#x`
resolves to the right private FieldId.

---

## 6. The hoisting protocol inside `__module_init` and any function

Hoisting is realized by ordering the lowering, not by inserting runtime
checks.

### 6.1 Function hoisting

Before lowering ANY statement of a function/module body:

1. Walk the body's statements (top-level only — NOT nested into other
   functions or classes; their bodies are lowered separately).
2. For each `FunctionDeclaration`: register its fnId / symbol in
   `funcSymbols`. (Existing: done by `assignIds` at module entry.)
3. The function's body itself is lowered ONCE later, but the binding is
   available throughout the containing body.

For the user's `function main` at module scope, this means:
- `assignIds` already gives `main` a fnId.
- The lowering of `__module_init`'s body sees a top-level call `main()` and
  resolves `main` via `funcSymbols` → `Call Direct { func: main_id }`.
- The body of `main` is lowered separately (also as a nested function of
  `__module_init` conceptually, capturing whatever module bindings it uses).

### 6.2 `var` hoisting

For each function (including `__module_init`):

1. Walk the function body (excluding nested functions) and collect every
   `var x` declaration.
2. At the top of the function's prologue, after the standard prologue
   steps but before statement lowering, allocate a local for each `var`
   binding and `Copy` the constant `undefined` into it.
3. During statement lowering, `var x = init` becomes `Copy x ← init`
   (the binding already exists; we just assign).

Today, `var x = init` is lowered as ensureLocal + Copy, which produces an
allocation at the textual position. Reading `var x` before that position
hits a `localOfSymbol` miss and silently creates a *new* local — incorrect.
The fix: pre-allocate at the prologue.

### 6.3 `let` / `const` non-hoisting

Today: ensureLocal + Copy at the textual position. Same as `var`. The lack
of a runtime TDZ check means an early read silently reads an uninitialized
slot.

Decision for v1: **rely on the TypeScript checker to reject early-read
TDZ violations at type-check time**, and accept that any program tsaot
accepts is well-formed in this regard. If we ever find a case the checker
permits but TDZ should reject, we can add a static check in the exporter.

This is consistent with our general "the TS checker is part of the
contract; tsaot trusts its judgment".

**Exception (v2, cross-module)**: this static-only stance holds ONLY for
TDZ *within a single module*, where source order makes the violation
statically visible. The TDZ that arises across a **cyclic ESM import** is
an evaluation-order-dependent *runtime* condition that the TS checker
cannot detect (verified empirically: a cyclic eager read compiles cleanly
but throws `ReferenceError` at runtime in Node). When v2 implements ESM
linkage, the `LoadImport` opcode therefore carries a runtime
initialized-check (a `TS_UNINITIALIZED` sentinel), unlike the in-module
`LoadField` which stays check-free. See `export_value_sharing.md` §5.2
and §7-6.

---

## 7. The module-init lifecycle, end to end

For a source file like:

```ts
const x = compute();
function main(): void { console.log(x); }
main();
```

The pipeline:

1. `assignIds` walks the AST; `main` and any other function/class declarations
   get fnIds.
2. The free-var pre-pass walks every nested function. `main` references
   `x` (a module-scope `const`); `x` becomes a `cellBindings` member.
3. `lowerSourceFile` synthesizes `__module_init` whose body is `[const x
   = compute(); main();]`.
4. Lower `__module_init`:
   - Prologue allocates a cell for `x` (because it's in `cellBindings`).
   - Lower `const x = compute()` → `compute()` returns a value; store into
     `x`'s cell via StoreField.
   - Lower `main()` → resolve `main` via `funcSymbols` → Call Direct.
     `main` is a function declared at module scope with the `x` cell in
     its lexical scope. When tsaot lowers `main`, it'll see `x` is a free
     var (a captured cell). At the AllocClosure that creates the value of
     `main`-as-a-function — wait, there's no AllocClosure: `main` is called
     as a Direct call, not via a closure value. But it still needs to access
     `x`'s cell at runtime.

   This is the subtle bit. **A `function f()` at module scope that captures
   a module-level binding needs that binding's cell to be accessible at
   `f`'s call site.** Today, this works for `compose(f, g)` because `f` and
   `g` are passed in as parameters (the cells become closure captures of the
   returned arrow). It does NOT work for a module-level `function main()`
   that references a top-level `const x` — there's no explicit closure
   creation.

   The fix: at module scope, `function main` is treated as **a closure value
   stored in a cell `cell_main`**, not as a plain Direct callee. When the
   user writes `main()`, the call goes through `cell_main` (LoadField the
   closure, Call Value). The closure's captures include any cells `main`
   needs (`cell_x`).

   Equivalently: `function main() { ... }` at module scope is lowered as
   `const main = function() { ... }` with the function body as the rhs.
   Closure conversion then proceeds as for any other arrow / function
   expression.

   This is a significant change. It affects performance (Direct calls
   become Value calls) but is the only correct approach for the general
   case. We can preserve the Direct call optimization when the function
   has NO captures — i.e. uses no module bindings.

5. Lower `main`: its body is `console.log(x)`. `console.log` is global
   built-in (case 4a) → CallBuiltinStatic. `x` is a captured cell →
   LoadField on `cell_x`.

6. emit_c entry: call `__module_init` (which runs the top-level
   statements in source order, including `main();`). The runtime then
   drives the event loop and exits. No auto-call of `main` — the user's
   `main();` at top level is the only thing that runs `main`.

### 7.1 The Direct-call escape hatch

Plain old `function main() {}` with no module-binding references should
NOT pay the closure-value cost. Detection:

- A module-scoped `function f` whose free-variable set is empty (no
  capture from module scope or any outer scope, since it IS at module
  scope and there's no outer scope above it except global built-ins)
  → lowered as a plain top-level function. Calls become Call Direct.
- A module-scoped `function f` whose free-variable set is non-empty
  → lowered as a closure value stored in a cell at the top of
  `__module_init`. Calls go through the cell.

Existing benchmark code (e.g. `int_kernel`, `obj_kernel`) is in the first
category — `function kernel(N) { ... }` without module-level captures —
and stays on the fast path. No perf regression expected.

---

## 8. Identifier as a value

`Math`, `Array`, `Object` etc. used as values (not as the receiver of a
property access or call) are **loud reject for v1**:

```ts
const m = Math;          // loud reject: "Math as a value"
foo(Array);              // loud reject
```

This is acceptable: real code seldom uses these as first-class values, and
v1 doesn't need to model the runtime objects. We can add this later by
giving the built-in namespaces actual runtime objects.

`undefined`, `NaN`, `Infinity`, `null` are values (constants), not
loud-reject.

---

## 9. Non-goals for v1

Explicitly out of scope, all loud-rejected:

- **Module linkage**: `import`, `export` (except type-only),
  `import()`, `module.exports`, `require()`, `__filename`,
  `__dirname`, `export default`, `export =`, `import = require()`,
  `export * from`, `export { X } from`, namespace imports
  (`import * as ns`), default imports (`import X from`). See
  `module_linkage.md` for the full v1 reject set, the type-only
  carve-out (which IS accepted), and the v2 design for multi-file
  programs. **Crucially**: the current exporter silently strips
  most imports and several export forms, which is a silent
  miscompile — v1 must replace those silent strips with loud
  rejections (per `module_linkage.md` §4.1).
- `eval`, `Function(...)` constructor — dynamic code.
- `with` statement — dynamic scope.
- `arguments` object as a free identifier (already partially supported as a
  special form in functions). Bare `arguments` outside a function is
  rejected.
- `this` at module top level (in CJS it's `module.exports`; in ESM it's
  `undefined`; in browser script it's the global object). For v1, `this`
  at module top level is loud-rejected.
- `globalThis.x = ...` (writing to global). The identifier `globalThis`
  itself is loud-rejected for v1.

---

## 10. What changes vs. what stays

### Removed / changed:
- `moduleVars: Set<Symbol>` in the exporter: removed (replaced by the
  general cell mechanism for module bindings).
- The exporter's path that emitted `StoreGlobal` for top-level `var`/
  `let`/`const` and `LoadGlobal` for nested-function reads of module
  bindings: removed. Those bindings now go through cells. The two IR
  opcodes themselves stay (see "Stays the same" below).
- All text-based identifier matches (`fn.text === "Math"`, etc.): replaced
  with `isBuiltinSymbol`-based classification.
- The current `#name` → string-field interning: removed. Private names go
  through a per-symbol FieldId allocation; two `#x` in different classes
  get different FieldIds.
- The method-registration loop in `assignIds`: extended to also handle
  MethodDeclarations / accessors with PrivateIdentifier names (currently
  silently skipped, which is why `#m()` segfaults today).

### Added:
- `isBuiltinSymbol(sym)` helper.
- `__module_init` synthesis (already designed; reuse).
- Hoisting prologue: function/var hoisting per function body.
- Module-scoped `function` → closure-value-in-cell when capturing.
- `privateFieldIdOf: Map<Symbol, FieldId>` per-symbol private-name table.
- `privateMembersOf: Map<classId, ...>` per-class private-member list.
- `HasField` IR opcode for `#name in obj` brand check.
- Static private storage: per-class container indexed by FieldId.
- `__static_init_<classId>` per-class synthesized function holding all
  static field initializers and static blocks in source order.
- Harness migration: V8 reference no longer appends auto-`main();`;
  existing tsaot tests get `main();` appended at the bottom of each file.

### Stays the same:
- The closure / cell / AllocClosure / LoadField-StoreField mechanism.
- The free-variable pre-pass (`freeVars`, `cellBindings`).
- Built-in dispatch tables (`namespaceBuiltin`, `builtinMethodName2`).
  Their inputs change (symbol classification instead of text) but
  their content is unchanged.
- **`Inst::LoadGlobal` and `Inst::StoreGlobal` IR opcodes**:
  retained as infrastructure for the GlobalEnvironment record.
  v1 has no producers because module bindings use cells instead, but
  the opcodes, the `globals: Vec<GlobalInfo>` field on `Program`, the
  `GlobalId` newtype, and the `GLOBALS[]` codegen wiring all stay so
  future features (`globalThis` writes, browser-classic-script mode,
  host-provided globals) can use them without re-introducing IR. The
  `internGlobal` helper in the exporter is also retained, even though
  the current call sites that invoke it (top-level `var` lowering and
  bare-identifier reads of module bindings) are removed. **The
  codegen for these opcodes — which I added earlier as ad-hoc work
  during the broken `__module_init` attempt — IS the right codegen
  and stays.** Without producers in v1, the `GLOBALS[]` array is
  zero-length and `ts_setup_globals()` is a no-op; that's correct.

### Small touches in modules that "mostly stay the same":
The earlier draft of this document claimed "the runtime does not change
at all" and "the analyzer's optimizations do not change at all". Both
are slightly wrong. The actual scope of analyzer-side change is
~120 lines total (now smaller because we keep Global infrastructure),
documented separately in `scope_redesign_analyzer_impact.md`. Summary:

- `analyzer/src/escape_ir.rs`: ~30 lines — add `Inst::HasField`, add
  `MethodKind::Static`, add static fields and
  `static_init: Option<FunctionId>` on `ClassDef`. **`GlobalInfo`,
  `GlobalId`, `LoadGlobal`, `StoreGlobal` all stay.**
- `analyzer/src/interproc.rs`: ~2 lines — add 1 arm
  (`Inst::HasField` materializes its obj). **The existing
  `StoreGlobal` / `LoadGlobal` handling stays** (currently sound:
  `StoreGlobal` forces materialization on src, `LoadGlobal` produces
  an `External` edge — both conservative and correct).
- `analyzer/src/sroa.rs`: ~1 line — add 1 (`HasField` needs its obj
  materialized). The `StoreGlobal` disqualification arm **stays**.
- `analyzer/src/call_graph.rs`: 0 lines. Just sees more `AllocClosure`
  edges as module-scoped capturing functions become closures.
- `analyzer/src/devirt.rs`: 0 lines. **But** module-scoped functions
  that capture module bindings lose Direct-call inlining (calls become
  Value calls). Mitigated by the Direct-call escape hatch (§7.1) for
  non-capturing functions, which covers all existing benchmark kernels.
- `analyzer/src/emit_c.rs`: ~70 lines — net simplification (delete
  earlier ad-hoc Globals work; add static_init dispatch + `HasField`
  codegen).
- `runtime/ts_rt.{c,h}`: ~15 lines — add `ts_has_field()` primitive
  for brand checks.

The optimizations themselves (escape analysis, SROA, devirt, monomorph-
ization) are unchanged in structure; only per-`Inst` dispatch tables
get one-line additions/removals. No invariants are weakened.

---

## 11. Open questions / decisions to ratify before implementing

These are the questions where we agreed on a direction but I want to flag
them explicitly so we don't surprise each other during implementation:

1. **Module-scoped `function f` that captures**: must become a closure
   value in a cell. Direct calls degrade to Value calls in those cases.
   **Confirmed: this is the correct semantics; performance impact is
   bounded (no impact for functions without captures).**

2. **`main` auto-call: REMOVED.** Earlier I tentatively retained it for
   tsaot's existing test convention, but it causes `tl3`-style double
   output (program prints "hi|hi") when the user's top-level code
   already calls `main();` and the runtime adds a second call. The fix
   is to align with JS semantics: tsaot does NOT auto-call `main`. The
   V8 reference harness's appended `if (typeof main === 'function')
   main();` is also REMOVED so V8 and AOT agree. **Existing tsaot
   tests** that relied on auto-call (`function main() {...}` with no
   call site) are migrated by appending `main();` to each file — a
   mechanical change. New tests follow the convention of writing
   `main();` explicitly.

3. **Module-scope `var x` shadowing a built-in name** (e.g. `const Math =
   { sqrt: ... }` at top level): correctly handled by symbol-based
   classification. The shadow is in `__module_init`'s scope; the built-in
   is "above" it; references from inside `main` resolve via the cell to
   `__module_init`'s Math.

4. **TDZ violations**: rely on the TypeScript checker; tsaot does not
   add a runtime check. If a program slips through the checker and into
   tsaot with a true TDZ violation, the behavior is undefined (most
   likely reads `undefined`, since pre-allocation of `let` slots gives
   them `TS_UNDEFINED`). I prefer this over emitting runtime TDZ checks
   that would cost performance throughout.

5. **`globalThis`, `this` at module level, `import`/`export`/`require`**:
   v1 loud-rejects. Explicit unsupported errors with clear messages.

6. **`class A { a = 1; foo() { return a; } }` (bare `a` inside method)**:
   the TypeScript checker rejects this with "Cannot find name 'a'"
   (assuming no outer `a` exists). tsaot must mirror: a bare identifier
   inside a method body does NOT silently become `this.a`. The §3
   resolution algorithm naturally produces this — sym is undefined or
   resolves to an outer binding, never to a class field.

7. **Private brand check `#x in obj`**: a new IR opcode `HasField` plus
   a runtime primitive `ts_has_field`. **Decision: include in v1**
   (it's the only correct way to implement brand checks, which the
   TypeScript checker emits for `#x in obj` syntax).

8. **Static private fields**: stored in a per-class static container
   indexed by FieldId, separate from instance prop maps. **Decision:
   include in v1; this is the natural extension of how public statics
   are stored on `C` itself today.**

9. **`class C { #m() {...} }` private method calls**: lowered as Direct
   calls to the registered method fnId, using the private FieldId as
   the dispatch key. **Decision: Direct call; TypeScript guarantees
   the receiver is an instance of C.**

10. **Static initialization model**: per-class `__static_init_<classId>`
    holding all static fields and static blocks in source order, called
    once at startup between `ts_register_classes()` and `__module_init()`.
    For classes declared inside functions, the static-init call is
    inlined at the declaration site (re-run each time the enclosing
    function is called). **Decision: confirmed; this matches JS
    semantics and reuses existing closure mechanism for captures.**

11. **`static { ... }` blocks**: lowered as inline statement sequences
    within `__static_init_<classId>` (not as separate functions). Block
    locals are locals of `__static_init_<classId>`. `await` inside a
    static block is loud-rejected for v1.

12. **`this` inside static methods and static initializers**: bound to
    the class object `C`. This is the existing behavior for static
    methods; extending it to static initializers via the same recv-slot
    convention.

---

## 12. Plan to implement (in a separate document)

The implementation is a substantial refactor of the exporter. It is best
done in sequenced steps, each verified independently before the next:

- **Step 0**: Rollback + harness + test migration.
  - **(a) Rollback ad-hoc work**: revert the session-5 changes that
    are design-rejected: the exporter's `__module_init` synthesis,
    the VariableStatement StoreGlobal-for-moduleVars arm, and the
    emit_c entry policy that auto-calls main after `__module_init`.
    Keep the `GLOBALS[]` array, `ts_setup_globals()`, and the
    `LoadGlobal`/`StoreGlobal` codegen — they're the right
    infrastructure for the GlobalEnvironment record even though
    nothing currently produces those opcodes after the rollback.
  - **(b) Harness migration — DEFERRED to post-Step-C**: removing the V8
    reference's appended `main();` and migrating test files to carry an
    explicit `main();` can only happen AFTER Step C lowers top-level
    statements — otherwise the migrated `main();` would be silently
    dropped (the very bug Step C fixes) and every test would break. So
    Step 0 KEEPS the current self-consistent alignment: V8 appends
    `main();`, the AOT entry calls `main` directly. The double-output
    bug (`hi|hi`) is already gone because (a)'s rollback removed the
    `__module_init`-then-also-call-main path. The auto-call removal +
    test migration is rescheduled to land immediately after Step C.
  - **(c) Test migration — DEFERRED with (b).**
  - **(d) Entry policy**: emit_c picks the first function as the
    entry, exactly as it did before session 5 (current `main_fn`
    fallback that searches by name "main" or else takes the first
    function — that's good enough for v1).
  - **(e) Loud-reject linkage**: replace the exporter's silent
    skips of `ImportDeclaration` / `ExportDeclaration` /
    `ExportAssignment` / `ImportEqualsDeclaration` with explicit
    `unsupported()` calls, per `module_linkage.md` §2.1. Carve out
    the type-only forms per `module_linkage.md` §2.2 (they continue
    to be erased). This step stops the silent miscompile of
    `import { readFileSync } from "fs"` becoming `undefined`.
    Affected exporter sites: the statement-skip list at ~line 3049,
    the `__module_init` builder's skip at ~line 3470 (which is
    being rolled back anyway in (a)), and any `lowerStmt` defaults
    that fall through silently.
  - Verify all existing tests pass after each sub-step. This step
    lands BEFORE the larger refactors so the doubled-output issue
    and the silent-import strip both stop being confounds during
    testing.

- **Step A**: Add `isBuiltinSymbol`. Migrate all text-based identifier
  matches to symbol-based ones. **No behavior change expected for
  existing tests** (they don't shadow built-ins), but the foundation
  is correct. Verify with shadow-test conformance cases.

- **Step B**: Stop emitting `LoadGlobal`/`StoreGlobal` for module
  bindings. Specifically: remove the exporter's `moduleVars`-driven
  paths that produce these opcodes (the top-level `var` lowering arm
  and the bare-identifier path that goes through `internGlobal`).
  Module bindings then have no producer until Step C wires them
  through cells; in the interim they revert to ensureLocal (today's
  silent-miscompile behavior — temporary, fixed by Step C). The IR
  opcodes themselves, the `globals: Vec<GlobalInfo>` field, the
  `GlobalId` newtype, the `internGlobal` helper, the `GLOBALS[]`
  codegen, and the `ts_setup_globals()` runtime hook all STAY as
  infrastructure for future producers (`globalThis` writes,
  browser-classic-script mode, host-provided globals). Existing
  tests must still pass — they don't depend on cross-function
  module-binding reads working, which is the bug we're about to
  fix properly in Step C.

- **Step C**: Implement (cleanly, after the Step 0 rollback) the
  `__module_init` synthesis and the cell-based representation of
  module bindings. Top-level non-declaration statements move into
  the synthetic function. Module-scoped `function` declarations
  that capture module bindings lower as closure-value-in-cell;
  non-capturing module-scoped functions stay on the Direct-call
  fast path (the escape hatch). Existing tests must still pass.
  Add new conformance tests for top-level patterns. Module bindings
  do NOT emit `LoadGlobal`/`StoreGlobal` — those opcodes remain
  unused infrastructure in v1.

- **Step D**: Hoisting pass (var + function). Add tests that depend on
  hoisting order.

- **Step E**: Class scope correctness for public members. Fix the bare-
  identifier-inside-method case (`class A { a = 1; foo() { return a; } }`)
  to resolve via §3 (not silently become `this.a`). Verify instance
  field initializers see the right scope (§5.7.1).

- **Step F**: Static members. Synthesize `__static_init_<classId>` for
  each class with static fields or static blocks, in source order.
  Call from entry between `ts_register_classes()` and `__module_init()`.
  Add `static` block support to the exporter's class-member walker.
  Tests covering: simple static field, static field referencing earlier
  static, static block referencing module const, static block with
  block-local `let`, mix of all three. Static methods stay unchanged.

- **Step G**: Private names. Implement `privateFieldIdOf`,
  `privateMembersOf`, the assignIds extension for PrivateIdentifier
  method/accessor names, the lowering of private field/method/accessor
  declarations and references, static private storage (using the
  per-class static container from Step F), and the `HasField` IR opcode
  + runtime primitive. Add tests covering all the scenarios in the §2.6
  table.

Each step is its own PR-equivalent change; each gates on full CI green
before proceeding.
