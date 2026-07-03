# Module linkage: `import` / `export` design (ESM only)

This document defines tsaot's plan for ES module `import`, `export`,
default exports, namespace imports, re-exports, and `import()`. It is a
companion to `scope_resolution.md` — the scope-resolution design treats
single-file modules; this document specifies how multi-file modules will
eventually be linked.

**tsaot supports ESM only.** CommonJS (`require`, `module.exports`,
`exports.x`, `export =`, `import x = require()`) is NOT supported and is
loud-rejected at all versions. The rationale and the value-sharing design
are in `export_value_sharing.md` §0. In brief: ESM and CJS have
fundamentally different semantics (live bindings vs property snapshots,
static vs dynamic export shapes, linked vs synchronous-require execution),
and supporting both doubles complexity for little benefit on a
TypeScript-first AOT compiler.

**v1 (the scope_resolution rewrite) does NOT implement module linkage at
all** — not even ESM multi-file. v1 is single-file. v1 loud-rejects every
import/export-linkage construct (and erases type-only ones). But the
EXPORTER and IR are designed so that v1's rejection is the same shape as
v2's ESM acceptance — adding linkage later should not require re-litigating
scope rules, IR opcodes, or runtime conventions.

This document was prompted by the observation that the current exporter
silently strips `import` statements, which is the same "silent
miscompile" anti-pattern we are fixing for top-level statements. The
correct v1 behavior is loud rejection across the board, with a
specific carve-out for **`import type`** (which has no runtime meaning
and can be safely erased).

---

## 1. Empirical baseline (current tsaot behavior)

Probed before writing this design:

| Construct                                  | Current exporter           | V8        | Verdict                |
| ------------------------------------------ | -------------------------- | --------- | ---------------------- |
| `export function foo(): number { ... }`    | Lowered as `isExported=true` | works     | OK for v1 (no link)    |
| `export const X = 7;`                      | Top-level var (silent ignore today; module-binding after Step C) | works | Hidden by Step C       |
| `export { Util };`                         | **silent** — ExportDeclaration skipped | works as re-export | **silent miscompile**  |
| `export default Util;`                     | loud-rejected as ExportAssignment | works as default | OK                     |
| `import { readFileSync } from "fs";`       | **silent** — ImportDeclaration skipped; ref to `readFileSync` evaluates to `undefined` | calls module | **silent miscompile**  |
| `import type { Buffer } from "buffer";`    | silent (correctly erasable)| erased   | OK (this is right)     |
| `import * as ns from "fs";`                | silent                    | works     | silent miscompile      |
| `import Default from "x";`                 | silent                    | works     | silent miscompile      |
| `import("./x").then(...)`                  | (untested; likely silent or unsupported) | works     | silent miscompile      |
| `require("fs")`                            | (depends on how `require` resolves) | works     | needs investigation    |
| `module.exports = ...`                     | (likely property access on undefined `module`) | works | silent miscompile      |

The "silent miscompile" rows are where v1 must act NOW — without
implementing the feature, just by loudly rejecting it so users aren't
left with silently-broken binaries.

---

## 2. v1 contract (the scope_resolution rewrite)

v1 implements **single-file modules only**. All module-linkage
constructs are loud-rejected with explicit unsupported errors, except
for the type-only forms which are erased.

### 2.1 Loud-reject set (with the message users will see)

| Construct                  | Exporter message                                  |
| -------------------------- | ------------------------------------------------- |
| `import { X } from "..."`  | `import declarations are not yet supported (single-file only)` |
| `import X from "..."`      | same |
| `import * as ns from "..."`| same |
| `import "..."`             | `bare side-effect imports are not yet supported`  |
| `import()` (expression)    | `dynamic import() is not yet supported`           |
| `export { X }`             | `export declarations are not yet supported`       |
| `export { X } from "..."`  | `re-exports are not yet supported`                |
| `export * from "..."`      | `star re-exports are not yet supported`           |
| `export default ...`       | `default exports are not yet supported`           |
| `export = ...`             | `CommonJS-style export = is not yet supported`    |
| `import X = require(...)`  | `import = require() is not yet supported`         |
| `require(...)` call        | `require() is not yet supported (use ES imports when linkage is supported)` |
| `module.exports = ...`     | `module.exports is not yet supported`             |
| `exports.X = ...`          | `commonjs exports.X is not yet supported`         |
| `__filename`, `__dirname`  | already loud-rejected (verify; tighten if needed) |

### 2.2 Erased (accepted, type-only, no runtime meaning)

These are **valid** in v1 because they have zero runtime impact:

- `import type { X } from "..."` — the entire import is type-only
  (the ImportClause's `isTypeOnly` is true). The exporter walks past
  it as if it didn't exist.
- `import { type X, type Y, runtimeZ } from "..."` — mixed; the
  individual specifiers' `isTypeOnly` is true for X and Y.
  **Important**: if any specifier is value-imported (`runtimeZ`
  above), the **whole declaration** is loud-rejected for v1.
- `export type { X }` — same: ExportSpecifier `isTypeOnly: true`.
- `export type X = ...` — TypeAliasDeclaration with `export`
  keyword; the `export` modifier on a type-only declaration is
  ignored (no runtime impact).
- `export interface I { ... }` — same.

### 2.3 Treated as ordinary at module scope

These constructs use the `export` keyword but their **runtime effect
in a single-file program is exactly the same as without the keyword**:

- `export function foo() { ... }` — `foo` becomes a module-scoped
  function (after Step C of `scope_resolution.md`); the fact that
  it's "exported" matters only for inter-module linkage, which v1
  doesn't have. The exporter records `isExported=true` on the
  function (already does this today, harmlessly).
- `export const X = ...`, `export let Y = ...`, `export var Z = ...`
  — module-scoped bindings; the `export` keyword is recorded on
  the binding's exported-flag for future linkage but has no v1
  runtime effect.
- `export class C { ... }` — same.

These remain valid programs in v1. The `export` keyword carries
**metadata** that becomes meaningful in v2.

### 2.4 The single carve-out: `import { X } from "..."` with no value uses

Edge case: `import { Foo } from "./helper"` where `Foo` is **only used
as a type** in the rest of the program (e.g., `function f(x: Foo)`).
The TypeScript checker tells us this via `isReferencedAliasDeclaration`
/ the resolver's emit-decision API: a value-import that's used only as
a type is *practically* equivalent to `import type`. v1 still
**loud-rejects** this form because:

- The user wrote `import { Foo }` (not `import type { Foo }`); the
  intent ambiguity (value or type?) should be made explicit.
- v2 will need to honor it as a value import for linkage purposes;
  treating it as erasable in v1 would break v2 compatibility.

The right user fix is to add `type`: `import type { Foo } from "./helper"`.
The exporter's error message should suggest this.

---

## 3. v2 contract (single-process multi-file linkage)

Once we support multi-file programs, the semantics tsaot adopts:

### 3.1 Module model

- **One TypeScript file = one module**. Each module has its own
  module scope (per `scope_resolution.md` §2). Two modules in the
  same program have completely separate module scopes.
- The compilation unit is **the closure of files reachable from an
  entry file via static `import` chains**. Dynamic `import()` is
  treated specially (§3.7).
- Modules are compiled together into a single C binary. There is no
  dynamic loading; "modules" are a compile-time organization
  feature, not a runtime feature. (Future: shared-object compilation
  with linker resolution. Out of scope.)

### 3.2 Module file target: ESM only

Only ESM is supported. ESM files use static `export` declarations whose
shapes are known at compile time, which suits tsaot's static-analysis and
type-driven-optimization approach. CommonJS files (`module.exports`,
`require`, `exports.x`) are loud-rejected. The full value-sharing design
for ESM is in `export_value_sharing.md`.

A file is treated as a module (ESM). Its top-level `export`/`import`
declarations define its interface. There is no CJS interop layer to
design or maintain.

The exporter builds a **module dependency graph** by following
`import` declarations from the entry file. Each node is a module;
each edge is an import. Cycles are permitted (and common).

For each module, the exporter produces:

- An IR `Module` record: name (canonical path), list of exported
  bindings (name → BindingId), list of imports (specifier path,
  imported name, local name).
- The module's `__module_init` function, which holds the top-level
  statements (lowered as today).
- A flag on each `BindingId` for "exported" / "exported as default".

### 3.4 Cross-module binding references

When module A imports `X` from module B:

```ts
// In A.ts:
import { X } from "./B";
console.log(X);
```

The TS checker resolves `X` in A's source to the `ImportSpecifier` in
A. That ImportSpecifier's symbol has an aliased symbol pointing at
B's exported declaration. The exporter follows the alias to find the
**owning module + BindingId**, and lowers the reference as:

- If B's `X` is a `function`/`class` declaration: `Call Direct` /
  direct class reference to B's id (cross-module direct call — both IR
  functions are in the same compiled program). See
  `export_value_sharing.md` §4.3.
- If B's `X` is a `var`/`let`/`const`: A's binding for `X` is an
  `ImportRef` (see `export_value_sharing.md` §3.1/§4.2). A's read of
  `X` becomes a `LoadImport` from the shared cell B allocated in its
  `__module_init`. The exporter ensures **B's `__module_init` runs
  before A's** (module init ordering, §3.5). Writes from A are
  loud-rejected (importer-side const-like).

### 3.5 Module initialization order

ESM: depth-first post-order over the static import graph from the entry
file. Spec-prescribed and well-defined for acyclic and cyclic cases; for
cycles, "live bindings" matter — see §3.6.

The C entry point runs all `__module_init_<N>` functions in the computed
order, then the program proceeds (the entry module's top-level statements
ARE its `__module_init` body).

### 3.6 ESM "live bindings"

In ESM, an imported binding is a **live reference** to the exporter's
binding. If module B does `export let counter = 0;` and then calls
`counter++` from inside, module A's `import { counter }` sees the new
value.

This is realized by the ImportRef + cell mechanism: B's `counter` is a
cell (`MODULE_B_counter`) allocated in B's `__module_init` and GC-rooted.
A's `counter` is an `ImportRef` whose slot holds the same cell. A reads
via `LoadImport` (= `ts_get(cell, FIELD_VALUE)`); B mutates via
`StoreField` on the same cell. Both modules see the same memory. A cannot
write (loud-rejected at compile time, matching the spec's "assignment to
constant"). Full design in `export_value_sharing.md` §4.

`import("./x")` returns a Promise. In a single-binary AOT world we
don't need to defer linking — the module is already linked. So
`import("./x")` becomes a Promise that resolves synchronously (or on
the next microtask) to the module's namespace object.

This requires materializing namespace objects: a frozen object with
properties matching the module's exports, where each property is a
**getter** that reads the live cell. The namespace object is
constructed lazily on first dynamic-import.

v2 may defer dynamic `import()` to v3 if it's not needed.

### 3.8 Default exports

`export default expr` in module B:
- If `expr` is a class declaration `class { ... }` or function
  declaration `function() { ... }`, it's equivalent to declaring a
  binding named `default` with that value.
- If `expr` is any other expression, it's evaluated at B's
  `__module_init` time and stored in a cell named `default`.
- `import X from "./B"` reads B's `default` binding.

### 3.9 Namespace imports

`import * as ns from "./B"` creates a namespace object containing all
of B's exports. Same machinery as §3.7's dynamic-import namespace
object, but materialized at link time rather than at first read.

### 3.10 Re-exports

- `export { X } from "./B"` — same as `import { X } from "./B";
  export { X };` but doesn't create a local binding in the current
  module. Lowered identically (the symbol's aliased declaration in
  B is used directly).
- `export * from "./B"` — copies all of B's named exports as exports
  of the current module. Requires the exporter to expand the star
  by enumerating B's exports.
- `export * as ns from "./B"` — combines namespace import + named
  export.

### 3.11 CommonJS: not supported

tsaot does not compile CommonJS modules. `module.exports`, `exports.x`,
`require(...)`, `export =`, and `import x = require(...)` are all
loud-rejected (at all versions). There is no CJS interop layer.

A consequence: tsaot programs cannot import npm packages that ship only
CommonJS, unless those packages also provide an ESM entry point. This is
an accepted limitation — tsaot targets self-contained TypeScript compiled
ahead-of-time, not the full npm ecosystem.

### 3.12 What we will NOT support (even in v2)

- CommonJS in any form (see §3.11).
- Browser classic scripts (top-level `var` → `globalThis`). Out of
  scope; tsaot is ESM-targeted.
- `<script type="importmap">`-style runtime remapping.
- Conditional exports (`package.json`'s `exports` field beyond a
  flat list of files; subpath patterns may be supported case-by-case).
- `with` clauses on imports (asserts/with — ES2025 import attributes).

---

## 4. What v1 must do RIGHT NOW (to be v2-compatible)

This is the part that affects the `scope_resolution.md` implementation
work. v1 doesn't implement linkage, but it MUST get these things right
so v2 doesn't require re-litigating them:

### 4.1 Loud-reject every linkage construct (no silent strips)

The current exporter silently skips ImportDeclaration and most
ExportDeclaration forms (at exporter.ts line 3470 in the __module_init
builder, and at line 3049-3050 in another statement-skip list).
**This must become loud rejection for v1** — except the carved-out
type-only forms (§2.2).

Add to the exporter a single helper `lowerOrRejectLinkage(stmt)` that
returns either "type-only, erase" or "loud-reject with specific
message".

This is independent of and additional to the scope_resolution work.
It can land as part of **Step 0** of the implementation plan, since
the fix is purely "stop silently skipping, start loudly rejecting" —
same shape as the test-migration work in Step 0.

### 4.2 Record `isExported` on module bindings

The exporter already records `isExported: bool` on functions. Extend
this to `var`/`let`/`const`/`class` bindings — the same flag, also a
bit per `MemberDeclaration` (export specifier). v1 doesn't use the
flag, but v2's cross-module linker reads it.

This is a small mechanical addition to the exporter's binding metadata.
**Lands during Step C of scope_resolution** (when module bindings get
their cell representation).

### 4.3 The IR has a `Module` record (even for single-file v1)

Today, the IR has a `Program` with a flat list of functions, classes,
globals. v2 needs to express "this function belongs to module M".
For v1's single-file world, there's only one module, so the field is
trivial. But we should add it now so that:

- The serialized JSON includes a `module: 0` (or `modules: [{id:0,
  name:"<entry>"}]`) field.
- The analyzer has the slot in `Function`/`ClassDef` for the owning
  module, defaulted to 0.

This is a cheap addition — ~5 lines in `escape_ir.rs`. Defer the
serialization until v2 actually needs it; just reserve the slot.

### 4.4 Built-in name resolution does NOT confuse with imports

The §3 algorithm in `scope_resolution.md` classifies a bare identifier
by inspecting its symbol's declaration site. An imported name has
its declaration in the user's source file (as an ImportSpecifier),
NOT in `lib.*.d.ts`. So `isBuiltinSymbol` correctly returns "not a
built-in" for imported names.

Verified empirically — see the §3.2 lookup at the top of this doc.

**Confirmation in `scope_resolution.md`**: case (d) "Declaration is
inside the current function (parameter, local var/let/const, nested
function declaration): this is a LOCAL" — for an imported name in
v2, the declaration is an ImportSpecifier at module top level, which
should be a new classification case **(g) IMPORTED BINDING** (v2
only). v1 loud-rejects before reaching this case.

I'll add (g) as a placeholder to `scope_resolution.md` with a
"v2 only" annotation, so the algorithm stays whole.

### 4.5 Re-exported binding is not the same as locally-exported binding

```ts
// In A.ts:
import { X } from "./B";
export { X };       // re-export from A
```

Here, A doesn't own a binding called `X` — A re-exports B's binding.
v1's `isExported` flag on a binding is owner-side; for v2's re-exports,
the exporter needs to record "re-exported name M maps to module N's
binding X". This is a per-module metadata table.

Out of v1 scope, but the data structure has a placeholder slot in the
IR's Module record.

### 4.6 The `__module_init` name will eventually be per-module

v1 has one `__module_init`. v2 will have `__module_init_<moduleId>`
per module. The exporter should ALREADY generate the name with the
module id suffix in v1 (as `__module_init_0`), even though there's
only one. This avoids a rename in v2.

(Wait — this is debatable. The user's debugger / error messages
would benefit from a stable name. Decision: keep `__module_init`
unsuffixed in v1; rename to suffixed form when v2 lands. The renaming
is mechanical.)

---

## 5. Impact on scope_resolution.md

The scope-resolution design is **mostly unaffected** because import/
export is orthogonal to in-file scope. But these refinements are
needed:

- **§3 algorithm**: add classification case **(g) IMPORTED BINDING**
  (v2-only). v1's exporter loud-rejects the import declaration
  before any reference is resolved, so this case is never hit in v1.

- **§9 (non-goals for v1)**: confirmed; the loud-reject set listed
  there is correct and matches §2.1 of this document.

- **§12 (implementation plan)**: Step 0 expands to include
  "loud-reject all linkage constructs except type-only", consistent
  with the rollback + harness migration already planned.

- **§10.added**: the IR additions for v1 should include an explicit
  `is_exported: bool` field on every binding (functions already have
  it; extend to var/let/const/class). The Module record placeholder
  is also added.

---

## 6. Summary

- **v1 behavior (what we implement now)**: loud-reject every form of
  module linkage except type-only imports/exports. Stop the silent
  strip; fix the silent miscompile.
- **v2 behavior (future)**: full single-process multi-file linkage
  with ESM + CommonJS interop, module init ordering, live bindings,
  re-exports, default exports, namespace imports, and dynamic imports
  (the last possibly deferred to v3).
- **Today's work**: 
  - Add a `lowerOrRejectLinkage` helper to the exporter as part of
    Step 0; cover the §2.1 reject set and the §2.2 erase set.
  - Add classification case (g) "IMPORTED BINDING" as a v2-only
    placeholder in scope_resolution.md.
  - Add `is_exported: bool` to module bindings (extending the
    existing function-level flag).
  - Reserve a Module record slot in the IR (no serialization yet).
- **What we explicitly do NOT do today**: no actual linkage, no
  cross-module reads, no `require` runtime, no namespace objects, no
  `import()` runtime.

The end goal is that adding v2 linkage is a **purely additive change**
on top of v1 — no rewrite of scope rules, no IR breakage, no runtime
restructuring. The infrastructure now (the loud-reject paths, the
metadata slots, the module-init shape, the cell-based binding model)
is the same infrastructure v2 will fill in.
