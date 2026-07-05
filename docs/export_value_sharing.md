# `export` value sharing — design via ModuleEnvironment and Ref types (ESM only)

A supplement to `module_linkage.md`. **tsaot supports ESM only.** CommonJS
(`require` / `module.exports` / `exports.x`) is loud-rejected throughout v1/v2.
This document defines a design that expresses ESM import/export value sharing in
terms of ModuleEnvironment and Ref types. It is not an implementation. It designs
down to the data-structure and Inst level.

## 0. Why ESM only

CJS and ESM look similar on the surface but are fundamentally different; supporting
both doubles the complexity:

- **Presence of live bindings**: ESM's `export let x` is visible as a live value
  from the importer side. CJS's `module.exports.x` is a property read (a
  destructure after `require` is a snapshot). The semantics differ fundamentally.
- **Timing of when the export shape is decided**: ESM is syntactically static
  (fixed by the `export` declaration). CJS is only decided once the assignment to
  `module.exports` executes (dynamic). ESM is an overwhelmingly better fit for
  tsaot's type-driven, static-analysis approach.
- **require's execution model**: CJS has its own execution model of synchronous
  execution + caching + partial initialization under cycles. ESM is static linking
  + postorder init.
- **The reality of TypeScript**: modern `.ts` code is overwhelmingly ESM.
  Hand-written `module.exports` in `.ts` is rare.

Therefore tsaot adopts a **single ESM module model**, and explicitly loud-rejects
all CJS syntax (`require()`, `module.exports`, `exports.x`, `import x = require()`,
`export =`).

Consistency with the V8 reference: for a single file with no imports, the
transpile result is identical under both CJS and ESM (verified). Thus the existing
V8 oracle (transpileModule) remains valid as-is. When adding tests that include
imports in the future, switch the oracle to ESM (`module: ESNext`).

---

## 1. What was wrong with the previous proposal

Previous proposal: place ESM's `export let x = 0` into tsaot's `GLOBALS[i]`.

Problems:
- **Name collisions**: module A's `export let x` and module B's `export let x`
  would end up sharing a "global." Even if you assign a different i, that is not a
  GlobalEnvironment but a "module-local named slot," which is a misuse of
  `GLOBALS[]`.
- **Crossed wires with `globalThis`**: per spec, ESM's `export let x` does not land
  on `globalThis`. Placing it in `GLOBALS[]` makes it hard to separate later when
  `globalThis.x` is implemented.
- **Conceptual confusion**: the spec's `GlobalEnvironment` and `ModuleEnvironment`
  are distinct Environment Records. tsaot should represent the two separately.

The correct model:
- Each module has its own `ModuleEnvironment`
- Inside the `ModuleEnvironment` are the `let`/`const`/`var`/`function`/`class` bindings
- The `x` binding in main obtained via `import { x } from "./B"` is **a reference
  that points to module B's `x` binding**
- The "reference" is a **Ref type, not a raw pointer** (because its behavior differs)

`GLOBALS[]` / `LoadGlobal` / `StoreGlobal` remain as infrastructure for **true
globals** (writes to `globalThis.x`, host-injected globals). They are not used for
export value sharing.

---

## 2. The need for a Ref type

The motivation for introducing a "Ref type" is explained through spec behavior.

### 2.1 Cases where the behavior differs

**(a) A local variable within the same module**

```ts
let x = 0;
function read() { return x; }
function bump() { x++; }
```

Reading/writing local `x` is an ordinary slot read/write. When `x` is captured by a
closure it becomes a `ts_object` cell (tsaot's current mechanism).

**(b) An ESM export**

```ts
// counter.mjs
export let x = 0;
```

```ts
// main.mjs
import { x } from "./counter.mjs";
x;                    // OK: live read (current value of x in counter.mjs)
x = 1;                // ERROR: assignment to constant variable (statically rejected)
```

On the importer side, **reads are allowed, writes are a static error**. This
cannot be expressed by just "a pointer to another module's slot." **The behavior
on write differs**.

**(c) namespace import**

```ts
import * as ns from "./counter.mjs";
ns.x;                 // live read
ns.x = 1;             // TypeError (at runtime, because it is a frozen object)
```

`ns` itself is a frozen object. Reading `ns.x` is live via a getter. Writing is a
TypeError because it is frozen. **Each property of the namespace points to a live
binding**.

### 2.2 In short

A "reference to another variable" has two distinct behaviors (two, since we
dropped CJS):

| Form | read | write |
|---|---|---|
| Local variable (cell) | slot read | slot write |
| ESM import binding | live from the export source | static error (compile-time rejection) |

If you represent all of these as "a pointer to a cell," the difference in write
behavior (slot write vs. static error) disappears. **Distinguishing them as Ref
types** lets lowering and the verifier judge correctly.

---

## 3. New IR concepts

### 3.1 Extending `Binding`

Add a kind to the existing `Binding` struct (around `escape_ir.rs:319`):

```rust
pub struct Binding {
    pub id: BindingId,
    pub name: String,
    pub decl_kind: DeclKind,   // existing: Var/Let/Const/Param/FunctionDecl/ClassDecl/CatchParam/Import/Builtin
    pub scope: ScopeId,
    pub type_id: TypeId,
    pub mutable: bool,
    pub tdz: bool,
    pub binding_kind: BindingKind,  // NEW: kind of value representation
    // ...
}

pub enum BindingKind {
    /// An ordinary local variable. The value is stored in that function frame, and
    /// becomes a cell when captured via a closure. Every binding so far is this one.
    Local,

    /// A binding that this module exports (let/var/const).
    /// Physically it is a cell, read/written the same as Local. But with is_exported = true
    /// it is made a GC root and referenced from other modules via ImportRef.
    LocalExport,

    /// A reference to a live binding imported from another ESM module.
    /// Read: returns the current value of the target (LoadImport opcode).
    /// Write: a compile-time error (the exporter loud-rejects it).
    ImportRef {
        from_module: ModuleId,
        from_binding: BindingId,
    },
}
```

The CJS-oriented variants (`CjsModuleExports` / `CjsImport`) are **not included**.

### 3.2 Extending `RefKind` (value classification)

The existing `RefKind` (`exporter.ts:23`):

```ts
type RefKind = "reference" | "primitive" | "unknown";
```

Add the concept of **ref-to-other-binding** to it:

```ts
type RefKind =
  | "primitive"      // existing: unboxed scalar
  | "reference"      // existing: boxed reference (ts_object value)
  | "unknown"        // existing: type-erased / any
  | "import_ref";    // NEW: value representation of an ImportRef binding
```

At runtime, `import_ref` holds "the cell it points to." On read it is indirected
via LoadImport. Writes are rejected at IR generation time.

### 3.3 New Inst set

```rust
/// Read through an import ref. `src` is a local whose binding is an
/// ImportRef. Codegen: ts_get(src, FIELD_VALUE) — cell read.
/// The verifier recognizes it as "a read that crosses a module boundary."
LoadImport { dst: LocalId, src: LocalId },

/// Materialize a namespace object for `import * as ns from "./B"`.
/// `module` is the target module id. The result is a frozen object, each of whose
/// properties is a getter that reads the corresponding ImportRef.
AllocNamespace { dst: LocalId, module: ModuleId, site: SiteId },
```

There is **no** write opcode for ImportRef. The exporter loud-rejects it at the IR
generation stage. The verifier guarantees that "a store whose src is an ImportRef
binding must not appear in the IR."

### 3.4 ModuleInfo

```rust
pub struct ModuleInfo {
    pub id: ModuleId,
    pub name: String,          // canonical path, e.g. "./counter"
    pub init_fn: FunctionId,   // this module's __module_init_<N>
    pub exports: Vec<ExportEntry>,
    pub imports: Vec<ImportEntry>,
}

pub struct ExportEntry {
    pub name: String,          // the public name (the bar of `export { foo as bar }`)
    pub binding: BindingId,    // the binding within this module (LocalExport)
    pub kind: ExportKind,      // Value | Function | Class | Default
}

pub struct ImportEntry {
    pub local: BindingId,      // the ImportRef binding within this module
    pub from_module: ModuleId, // the target module
    pub from_binding: BindingId, // the binding within the target module (LocalExport)
}

pub enum ExportKind { Value, Function, Class, Default }
```

The `ModuleKind` enum is unnecessary (ESM only).

---

## 4. Runtime representation

### 4.1 LocalExport binding

In implementation terms it is **exactly the existing cell mechanism**. In the
frame of `__module_init_<B>`, `AllocObject` allocates a `ts_object`, `StoreField
.VALUE` initializes it, and it is registered as a GC root (since it is exported,
its lifetime spans the entire program).

```c
static tsv MODULE_B_x;   // GC root, its content is a ts_object (cell)

void __module_init_B(void) {
  MODULE_B_x = ts_new_object();
  ts_gc_root(&MODULE_B_x);
  ts_set(MODULE_B_x, FIELD_VALUE, ts_num(0));  // export let x = 0
  // ...
}
```

References to `x` inside B are `ts_get(MODULE_B_x, FIELD_VALUE)` and
`ts_set(MODULE_B_x, FIELD_VALUE, ...)`. Exactly the same as the existing cell
lowering.

### 4.2 ImportRef binding

Importer A establishes the reference at the point of import:

```c
static tsv MODULE_A_x;   // slot that holds the ImportRef

void __module_init_A(void) {
  // required: B must be initialized first (the linker guarantees the order)
  MODULE_A_x = MODULE_B_x;   // shares the same cell object
  ts_gc_root(&MODULE_A_x);
}
```

References to `x` inside A are the **`LoadImport` opcode**:

```c
// LoadImport dst src=MODULE_A_x → dst = MODULE_A_x.VALUE
tsv val = ts_get(MODULE_A_x, FIELD_VALUE);
```

Since `MODULE_A_x` itself holds the cell object, there is one level of
indirection. A write like `x = 1` in A-side code is **loud-rejected by the exporter
at IR generation time**.

#### 4.2.1 The continuity between "local variable ↔ ImportRef"

The cell mechanism and ImportRef have **the same physical layout** (in both, "the
`.VALUE` field of a `ts_object` is the current value"). The differences:

- Local variable: creating the cell and reading/writing it both happen within the same module
- ImportRef: the cell is created by the export source, read by the import side, and written only by the export source

The physical representation is complete simply by making the existing cell
mechanism "referenceable across module boundaries." **No new runtime mechanism is
needed**. The only new addition is the distinction at the IR level.

### 4.3 Exporting functions and classes

In the case of `export function f() {...}`, `f` is a non-reassignable, const-like
binding (per spec, a function declaration is an immutable binding).

- B side: `f` is an ordinary functionId; inside `__module_init_B` it is an fnRef value
- Importer A side: `import { f } from "./B"` **imports f's static functionId**. An
  `f(...)` call on the A side is `Call Direct { func: B's fId }`

A **direct reference** that does not go through an ImportRef. Reasons:
- ESM's function binding is non-reassignable, so there is no need for indirection
- For performance, a direct call is overwhelmingly faster

However, if `f` on the B side captures a module variable (the case where the escape
hatch of `scope_resolution.md` §7 does not apply), `f` is represented as a
cell-bound closure, and the import side also accesses it via the cell. The linker
decides.

Classes are the same. `export class C` is a direct reference via classId.

#### 4.3.1 A unified view

There are two kinds of ESM export:

- **Value exports** (`let`/`var`/`const`): via ImportRef (cell + LoadImport)
- **Static exports** (`function`/`class`): direct reference (the linker resolves
  the functionId/classId)

This corresponds to the spec's binding mutability (`export let x` is mutable,
`export function f` is immutable).

### 4.4 namespace import (`import * as ns from "./B"`)

`ns` is a Module Namespace Object (spec §18). Characteristics:

- **read-only view**: each property is a live read of the corresponding binding.
  `ns.x` returns the export source's current value every time (via a getter).
- **Not writable**: `ns.x = 1` is a runtime TypeError (the `setProperty` of spec
  §18.2 is always false).
- **exportNames are fixed and sorted** (spec §18.2). `Object.keys(ns)` is the
  sorted list of export names.
- **Includes `default`** (a namespace, unlike `export *`, includes default).
- **A non-existent name is `undefined`** (not a throw).

```c
// AllocNamespace dst module=B site=...
tsv ns = ts_new_namespace_object(B_module_id);
//   exportNames are sorted: ["bump", "counter", "default", ...]
//   each own-property is a getter:
//     "counter" → LoadImport from MODULE_B_counter (live, with a TDZ check)
//     "bump"    → B's bump as a fn value (direct)
//   [[Set]] always fails (read-only)
```

Each property read of the namespace passes through the same TDZ check as the
`LoadImport` of §4.2 (reading an uninitialized binding via a namespace during a
circular import is a ReferenceError).

Optimization: since the cost of constructing a namespace object is high,

- If `ns` is passed to another function or assigned to a variable → materialize it with AllocNamespace
- If it is used only as the receiver of a propaccess like `ns.x` → do not create an
  AllocNamespace; replace it in place with the corresponding LoadImport / direct reference

This is the linker's responsibility.

### 4.5 default export

`export default expr` is treated as an export with the name `default`.

- `export default 42` → name `default`, kind=Value, evaluated inside `__module_init_B`
- `export default function f() {}` → name `default`, kind=Function
- `export default class C {}` → name `default`, kind=Class

Importer side: `import X from "./B"` is equivalent to
`import { default as X } from "./B"`. Same mechanism as §4.2 / §4.3.

### 4.6 Re-exports

```ts
// b.mjs
export { v } from "./c.mjs";
```

The `v` entry in B's export table **points directly to c.mjs's v binding**. The
linker resolves it by following the alias chain:

```rust
// b.mjs's ExportEntry:
ExportEntry {
  name: "v",
  binding: BindingId(c.mjs's v),  // ← points directly at c.mjs's binding
  kind: ExportKind::Value,
}
```

When importer A does `import { v } from "./B"`, A's ImportRef sets **c.mjs's v** as
from_module/from_binding (it does not go through B). The chain overhead disappears.

`export * from "./c.mjs"` is the same. At link time, all of c's exports are
registered flatly as B's exports. Name collisions follow the spec's rules (a
collision between two `export *`s is ambiguous, and importing that name is a
reference error). `default` is not re-exported by `export *` (a caveat of spec
§10.4).

### 4.7 side-effect import / mapping table of all import forms

This covers all the import forms of §6.8 of the provided ESM specification:

| Syntax | localName | tsaot's representation |
|---|---|---|
| `import v from "mod"` | `v` | ImportRef (target=`default`) or direct ref |
| `import * as ns from "mod"` | `ns` | namespace binding (§4.4) |
| `import { x } from "mod"` | `x` | ImportRef (target=`x`) |
| `import { x as y } from "mod"` | `y` | ImportRef (target=`x`), local name is `y` |
| `import "mod"` | none | **creates no local binding**. Only adds it as a dependency to the link/evaluate set |
| `import type { T } from "mod"` | (type only) | **erase** (no runtime representation) |

`import "./setup.mjs"` (a side-effect import) creates no binding, but
`setup.mjs`'s `__module_init` is **evaluated in postorder** as a dependency (spec
§9.4). tsaot draws it as an edge in the module graph but creates no ImportEntry.

In a renamed import (`import { x as y }`), **only `y` is a local binding**. The
name `x` is not created in the importer's ModuleEnvironment (empirically confirmed:
referencing the original name after a renamed import is a ReferenceError).

### 4.8 strict-mode invariants (spec §21, §22)

ESM is always strict mode code (spec §2.1). The invariants when tsaot supports ESM:

- **Top-level `this` is `undefined`** (spec §21). `scope_resolution.md` §9 already
  loud-rejects module-level `this`, but when ESM is fully implemented in v2 the
  correct behavior is to treat it as `undefined` (change from reject to returning
  `undefined`).
- **Assignment to an undeclared identifier is a ReferenceError** (spec §11.2). The
  implicit global creation of sloppy mode does not occur. tsaot loud-rejects
  unresolved identifiers (it can detect them at compile time).
- **`delete identifier` is a SyntaxError** (spec §22.4). The TS checker rejects
  this statically. tsaot needs no additional check.
- **Assignment to an import binding is a TypeError/SyntaxError** (spec §13.2). tsaot
  loud-rejects it at IR generation time as in §4.2.

---

## 5. The linker

tsaot compiles all modules into a single binary. Linking is resolved **at compile
time** (no dynamic loading).

Correspondence with the three phases of §15 of the provided ESM specification
(Load/Parse → Link/Instantiate → Evaluate):

| spec phase | handled in tsaot by | timing |
|---|---|---|
| Load / Parse | the exporter parses all modules with the TS checker | compile time |
| Link / Instantiate | the exporter + linker finalize bindings/export tables/import refs and generate IR | compile time |
| Evaluate | run the generated `__module_init_<N>` in postorder | runtime |

Of the spec's `ModuleStatus` (new/loaded/linking/linked/evaluating/evaluated/
errored), **Load through Link are all resolved at compile time**, so at runtime
only states corresponding to evaluating/evaluated remain. Thanks to AOT,
cyclic SCC detection and link errors are settled at compile time.

### 5.1 The linking process (compile time)

1. **Build the module graph**: from the entry file, follow the static edges of
   `import`/`export from`/side-effect import (`import "./x"`) and enumerate all
   involved modules (spec §15.1 Load + requestedModules collection)
2. **Symbol resolution**: for each import, follow the TS checker's alias to
   identify the **owning module + binding**. Flatten re-export chains to the final
   owner. Name collisions from `export *` are detected as ambiguous (spec §10.4
   ResolveExport)
3. **SCC detection**: find strongly connected components in the module graph via
   DFS (spec §17.2). Cycles are handled per SCC. **However, since this is AOT,
   finalizing bindings within an SCC is entirely at compile time**. Only the
   evaluation order (postorder) remains at runtime
4. **Code generation**: generate a `__module_init_<N>` for each module. From the
   entry point, call every module's init in postorder in sequence
5. **Finalize cell addresses**: cells for exported bindings are allocated inside
   `__module_init_<N>` and stored in a global static. The importer references that
   static directly

### 5.2 Circular imports and TDZ (an important correction)

An ESM cycle:

```ts
// x.mjs
import { yfn } from "./y.mjs";
export let xval = 100;
export function xfn() { return xval; }
console.log(yfn());      // calls y.mjs's function (functions are forward-resolved)

// y.mjs
import { xval, xfn } from "./x.mjs";
export function yfn() { return xfn(); }  // at runtime xfn is already initialized
```

In ESM, "binding resolution is at link time, value reference is at runtime." Access
via functions works even in a cycle (empirically confirmed).

**Here we correct the previous proposal.** The previous proposal said "delegate TDZ
to the TS checker and do not emit runtime checks" (the within-single-module policy
of `scope_resolution.md` §6.3), but **the TDZ of a circular import is a runtime
condition that the TS checker cannot detect statically** (confirmed empirically:
the code below is error-free under tsc but a ReferenceError at runtime):

```ts
// a.mjs
import { b } from "./b.mjs";
export let a = "A";
console.log(b);          // ReferenceError if b is uninitialized (at runtime)

// b.mjs
import { a } from "./a.mjs";
export let b = "B";
console.log(a);          // ReferenceError unless a.mjs was evaluated first
```

Running `node a.mjs` produces `Cannot access 'a' before initialization` (verified).
Because tsc cannot statically trace the evaluation order of circular dependencies,
it **cannot raise this error at compile time**.

Therefore **reading an ImportRef requires a runtime TDZ check**. This is a separate
matter from the within-single-module `let`/`const` TDZ (which
`scope_resolution.md` §6.3 delegated to the TS checker). The distinction:

- **Within-same-module `let`/`const` TDZ**: statically determinable by source order
  → delegate to the TS checker (keep the existing policy).
- **ImportRef TDZ across a circular import**: an evaluation-order-dependent runtime
  condition → tsaot **emits a runtime check**.

Implementation: give the cell (`ts_object`) a flag for "whether it is initialized."
This corresponds to the `Cell { initialized, mutable, value }` model of §6.6 of the
provided ESM specification. In tsaot:

- A cell for an exported binding is **uninitialized** at the point it is allocated
  in `__module_init_<B>` (in the `let`/`const` case). It becomes initialized when
  the initializer runs. `var`/`function` are initialized at allocation time (hoist).
- `LoadImport`'s codegen checks the initialization flag before returning the value:
  ```c
  // LoadImport dst src=MODULE_A_x
  if (!ts_cell_initialized(MODULE_A_x)) ts_throw_tdz("x");
  dst = ts_get(MODULE_A_x, FIELD_VALUE);
  ```
- Ordinary in-module cell reads (`LoadField`) do not get a TDZ check (because it is
  statically guaranteed). Only `LoadImport` carries the check.

This is a v2 matter. Since v1 is a single file, circular imports cannot occur and
`LoadImport` itself is not emitted. However, **the design of giving cells an
initialized flag** should be built into the `ts_object` representation already at
the v1 stage (retrofitting it later would be a costly runtime layout change).
Details in §7.

### 5.3 This is distinct from the GlobalEnvironment mechanism

A cell for an exported binding is a **per-module static** (`MODULE_B_x`), not
`GLOBALS[]`. `GLOBALS[]`/`LoadGlobal`/`StoreGlobal` are exclusively for true globals
(`globalThis`, host injection). The two are separate layers.

Corresponds to the hierarchy of §3 of the provided ESM specification:

```
Realm
  └─ GlobalEnvironment           ← tsaot's GLOBALS[] / builtins
       ├─ globalThis
       ├─ built-in globals (console, Array, ...)
       └─ global lexical bindings
ModuleRecord(B)
  └─ ModuleEnvironment           ← tsaot's per-module cells (MODULE_B_x)
       ├─ import bindings (ImportRef)
       └─ top-level var/let/const/function/class bindings
```

This corresponds to `ModuleEnvironment.[[OuterEnv]] = GlobalEnvironment`
(specification §6.2), and tsaot's scope-chain resolution order is:
```
Local → outer function (capture) → ModuleEnvironment (incl. import) → Global builtins
```

---

## 6. The big picture

### 6.1 Final form of BindingKind

```rust
pub enum BindingKind {
    Local,        // an ordinary local variable (made a cell via a closure)
    LocalExport,  // a binding that this module exports (cell + GC root)
    ImportRef { from_module: ModuleId, from_binding: BindingId },  // ESM import
}
```

### 6.2 Added Insts

```rust
LoadImport { dst: LocalId, src: LocalId },
AllocNamespace { dst: LocalId, module: ModuleId, site: SiteId },
```

### 6.3 Key lowering rules

| Source | tsaot's lowering |
|---|---|
| `let x = 1` at module top (not exported) | `Local` binding, AllocObject (cell), StoreField .VALUE = 1 |
| `export let x = 1` | `LocalExport` binding, AllocObject, StoreField, GC root |
| `let x` reference (within same module, already cell-ized) | `LoadField cell FIELD_VALUE` |
| `x = 2`, same | `StoreField cell FIELD_VALUE = 2` |
| `import { x } from "./B"` | create `ImportRef` binding, finalize from_binding at link time |
| `x` reference (importer side, ImportRef) | `LoadImport src=ImportRef_local` |
| `x = 2`, same | **exporter loud-rejects** (static const-like) |
| `import * as ns` reference | the linker observes ns property accesses and optimizes to an immediate LoadImport etc., or materializes with AllocNamespace |
| `export function f` | the linker makes it externally referenceable (direct reference) |
| `import { f } from "./B"`, `f()` | `Call Direct { func: B::fId }` |
| `export class C` | direct class reference (classId) |
| `export default expr` | export with the name `default` |
| `export { v } from "./c"` | re-export, flattened to the final owner |
| `require(...)` / `module.exports` / `exports.x` / `export =` / `import x = require()` | **loud reject** (CJS is unsupported) |

### 6.4 Impact on the analyzer

Updates to `scope_redesign_analyzer_impact.md`:

- **escape_ir.rs**: add the `BindingKind` enum, add `Inst::LoadImport` /
  `Inst::AllocNamespace`, add `ModuleInfo` / `ExportEntry` / `ImportEntry`. The
  Global infrastructure stays as-is.
- **interproc.rs**: `LoadImport` has the same shape as `LoadField` (reading another
  object's field) → add 1 arm. `AllocNamespace` is a frozen object + a set of
  getters → always treating it as External is fine (1 arm).
- **sroa.rs**: `LoadImport`'s src is a cell, so it needs materialization (treated
  the same as `LoadField`'s obj). `AllocNamespace`'s dst is also materialized.
- **devirt.rs**: no impact.
- **emit_c.rs**: `LoadImport` → a single `ts_get(src, FIELD_VALUE)`.
  `AllocNamespace` → frozen object + a set of getters.
- **call_graph.rs**: no impact.

interproc does not need to track "aliases that cross module boundaries" in order to
handle ImportRef. The src local of an ImportRef is itself an ordinary `ts_object`
value, and its alias analysis is as before. LoadImport has the same shape as
LoadField.

---

## 7. What to reserve in v1

v1 is a single-file ESM module (no import/export). Multi-file linkage is v2. IR
extensions reserved in v1:

1. Add **`Binding.binding_kind: BindingKind`**. In v1 all bindings are
   `BindingKind::Local` (including module-scope bindings — since v1 is a single
   module, even if exported there is no other module to reference them).
2. Register **`Inst::LoadImport`, `Inst::AllocNamespace`** in the IR enum. In v1 the
   emitter does not emit them. Fill the analyzer/codegen arms with `unreachable!()`
   or a clear error, and implement them in v2.
3. Add **`ModuleInfo`/`ExportEntry`/`ImportEntry`** to `Program`. In v1: a single
   ModuleInfo (the entry file), empty imports, and exports corresponding to
   bindings with `is_exported=true`.
4. Add **`import_ref` to `RefKind`** (exporter). Not used in v1.
5. **Loud reject of CJS syntax** is done in v1's Step 0 (`module_linkage.md` §4.1).
   Explicitly make `require` / `module.exports` / `exports.x` / `export =` /
   `import x = require()` unsupported.

6. **[New, needs attention] The cell's initialized flag**: following the
   `Cell { initialized, mutable, value }` model of §6.6 of the provided ESM
   specification, reserve a means to represent "whether it is initialized" in
   tsaot's cell (`ts_object`). This is essential for the TDZ check across circular
   imports (§5.2).

   **This is hard to retrofit, so it is worth deciding in v1**: the current cell is
   a single `.VALUE` field of a `ts_object`. Options for where to put the
   initialized flag:
   - (a) Use one flag bit in the header of the cell `ts_object` (a layout change,
     but be careful since it affects all ts_object)
   - (b) Make `.VALUE`'s initial value a special sentinel `TS_UNINITIALIZED` (a
     NaN-box tag distinct from `TS_UNDEFINED`), and on read, TDZ throw if it is the
     sentinel
   - (c) Give the cell a second field `.INITIALIZED`

   **The recommendation is (b)**: just adding one `TS_UNINITIALIZED` tag to
   NaN-boxing keeps the cell layout unchanged, and `LoadImport`'s codegen becomes
   "if the read value is `TS_UNINITIALIZED`, throw." It can also be applied to
   ordinary within-single-module `let`/`const` cells (though v1 does not use it,
   leaving it to the TS checker), becoming a consistent TDZ mechanism in the future.

   v1 does not emit TDZ checks, but **reserve just the `TS_UNINITIALIZED` tag in
   v1's NaN-boxing design** (tag space is finite, so cramming it in later is a
   hassle). Adding the sentinel definition and `ts_is_uninitialized()` to the
   runtime is a few lines.

---

## 8. Summary of where the "Ref type" fits

"A new type that holds a reference to another variable" is split into three layers
in tsaot:

| Layer | Representation |
|---|---|
| IR value classification (`RefKind`) | the `import_ref` variant (indicates the value is a live import binding) |
| IR binding classification (`BindingKind`) | `ImportRef { from_module, from_binding }` (the kind of the binding itself) |
| IR opcode | `LoadImport` makes the read explicit. Writes do not exist at the IR level (the exporter rejects them) |

Only when these are all in place:
- the analyzer recognizes "this is a live binding read"
- codegen unambiguously lowers "LoadImport reads the src cell's .VALUE (with an
  initialization check)"
- the verifier guarantees "a write to an ImportRef binding must not appear in the IR"
- future optimizations (such as inlining within-same-module export bindings) use the type information

This carries information that "a raw pointer" cannot express at all.

### 8.1 Terminology correspondence with the provided ESM specification

Terminology correspondence between the provided specification (VM-implementation
viewpoint) and tsaot (AOT-compiler viewpoint):

| Specification concept | tsaot correspondence |
|---|---|
| `ModuleEnvironment` | per-module cells + the exporter's symbol resolution |
| `ModuleFrame` / `Cell[]` | an exported binding is `static tsv MODULE_B_x` (a GC-rooted ts_object cell) |
| `Cell { initialized, mutable, value }` | a `ts_object`'s `.VALUE` + the `TS_UNINITIALIZED` sentinel (§7-6) + mutable is determined statically from the IR's binding_kind / TS const-ness |
| `ImportBinding { targetModule, targetSlot }` | `BindingKind::ImportRef { from_module, from_binding }` |
| `DirectBinding` | `BindingKind::Local` / `LocalExport` |
| `ModuleNamespaceObject` | the read-only object generated by `Inst::AllocNamespace` |
| `ExportTable` / `ResolveExport` | the linker's compile-time symbol resolution (`ModuleInfo.exports`) |
| Load / Link / Evaluate (spec §15) | Load+Link are compile time, Evaluate is `__module_init_<N>` runtime |
| `ModuleStatus` state machine | resolved at compile time (only the evaluation order remains at runtime) |
| SCC detection (spec §17.2) | performed by the linker at compile time |

**The fundamental difference**: the specification assumes an **interpreter VM**
(doing Link/Evaluate at runtime). Since tsaot is an **AOT compiler**, it collapses
Load/Link entirely at compile time. What remains at runtime is only Evaluate
(calling each module's `__module_init` in postorder) and the TDZ sentinel check for
circular imports. As a result, most of the spec's `ModuleStatus`/SCC mechanism
disappears at compile time.

---

## 9. Design decisions to confirm

1. **ESM only** (all CJS syntax is loud-rejected). Is this OK?
2. **Represent the "Ref type" across the three layers of IR binding_kind / RefKind / opcode**. OK?
3. **Do not represent ImportRef writes at the IR level; the exporter loud-rejects
   them statically** (a static translation of the spec's "assignment to constant").
   OK?
4. **Function and class exports are direct references, not via ImportRef**. OK?
5. **namespace import has a two-tier optimization** (if it is only a propaccess,
   lower directly to LoadImport; if it is turned into a variable, materialize the
   namespace object). OK?
6. **Reserve BindingKind / LoadImport / AllocNamespace / ModuleInfo / import_ref in
   the IR in v1** (implementation in v2). OK?
7. **TDZ across circular imports is a runtime check**. `LoadImport` reads only after
   checking for the sentinel `TS_UNINITIALIZED`. Within-single-module `let`/`const`
   TDZ is left to the TS checker as before (static); only here is a runtime check
   emitted. For that, **reserve the `TS_UNINITIALIZED` tag in NaN-boxing in v1**. OK?

**All 7 points confirmed (agreement reached).** The design is settled.

### 9.1 Performance positioning (settled matters)

Variable imports (reading the live binding of `export let`/`const` via
`LoadImport`) **may be slow**. Reasons and consequences:

- Variable imports are rare in real code. The vast majority of imports are
  functions, classes, and types, and those are **direct calls / direct references**
  (no check, fastest), not via ImportRef.
- Therefore the cost of `LoadImport`'s TDZ sentinel check (the branch that tests for
  `TS_UNINITIALIZED`) is **acceptable**. It is unlikely to be on a hot path, and its
  optimization priority is low.
- Summary:
  - **Kept fast**: function/class imports (direct), ordinary within-same-module
    variable access (`LoadField`, no check), and all existing benchmarks
  - **May be slow**: variable-import reads (`LoadImport` + sentinel check)
- With this trade-off, there is no near-term need to add further optimizations such
  as closure-call devirt to variable imports.
