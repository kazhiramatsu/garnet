# Top-level statements: lowering the implicit module body

## The bug

Today, tsaot's exporter silently drops every top-level statement that isn't a
function or class declaration. Concretely, at the bottom of
`buildIRFromSourceFile` (exporter.ts ~line 3428):

```ts
for (const stmt of sf.statements) {
  if (ts.isFunctionDeclaration(stmt) && stmt.body) {
    // ... lowered
  }
}
```

Everything else — `VariableStatement`, `ExpressionStatement`, `IfStatement`,
`ForStatement`, `WhileStatement`, `TryStatement`, etc. at module level — is
discarded with no error. The exporter reports `OK` and produces an IR
program that compiles to a C binary that does nothing.

This violates the project-wide principle of "never silently miscompiling." It also
violates JS/TS semantics: in actual JavaScript, top-level
code is the module body that runs when the module is loaded.

## What programs look like

Real-world TypeScript programs frequently mix the two styles:

```ts
// Pattern 1: explicit main (currently supported)
function main(): void {
  console.log("hello");
}

// Pattern 2: top-level (currently silently dropped)
console.log("hello");

// Pattern 3: mixed — top-level setup + a main() entry
const config = loadConfig();
function main(): void {
  use(config);
}
main();

// Pattern 4: top-level calls a top-level-defined function
function greet(name: string) { console.log("hi " + name); }
greet("world");

// Pattern 5: module with a class plus top-level kickoff
class App { run() { console.log("ok"); } }
new App().run();
```

V8 / Node executes patterns 1–5 identically: the module's statements run in
order, and any `function main()` declaration is hoisted (so it can be
forward-referenced). Pattern 1 only "uses" main because the harness explicitly
calls it after transpile.

## Design

### Choice: lower the entire module body into an implicit synthetic `main`

When a source file has top-level statements that are NOT pure declarations,
synthesize an implicit `main` function whose body is the lowered top-level
statements (in source order). The synthetic main becomes the program's
entry point. Existing files with an explicit `function main()` keep working
unchanged.

Why this approach (over the alternatives):

- **Smallest diff**: a localized change in `buildIRFromSourceFile`. No
  changes to lowerStmt, no changes to the analyzer or runtime.
- **Preserves the runtime contract**: emit_c.rs already searches for the
  function named `main`. If we name our synthetic function `main`, the
  runtime entry just works.
- **Matches the V8 oracle naturally**: V8 runs top-level statements as the
  module body, and our transpile-batch appends `if (typeof main === 'function')
  main();`. With the synthetic main, both worlds execute the same statements,
  exporting the same observable behavior.

### Conflict resolution: what if the user wrote `function main()` AND has
non-declaration top-level statements?

```ts
const x = 1;             // (a) top-level
function main(): void {  // (b) user-defined main
  console.log(x);
}
main();                  // (c) top-level call
```

In Node: (a) runs, (b) is hoisted but its body doesn't execute, (c) calls it
and prints 1.

The correct lowering is to put (a) and (c) into the synthetic body, and let
(b) be its own function the synthetic body can call. But (b) is named `main`
and (c) calls `main`. If we name our synthetic function `main` too, we get
a conflict: the user's main and our synthetic main both want the same
function id at the runtime entry point.

Resolutions:

- **(R1) Detect explicit main**: if the user wrote `function main()`, do NOT
  synthesize a wrapping main. Just lower top-level statements as a separate
  function (call it `__module_init`) AND emit the entry code to call it
  before main. This is the cleanest semantically.

- **(R2) Rename user main**: rename the user's `main` to `__user_main`
  internally, generate a synthetic `main` that runs top-level (with the
  user's main now being one of the lowered references). Brittle (name
  resolution gets weird) and surprising.

- **(R3) Merge**: bias the synthetic main to be the user's main, prepending
  any pre-main top-level statements. But (c) is after the function decl
  and naturally runs in Node AFTER the function body — that won't fit.

R1 is the right call. The runtime entry then becomes:

```c
int main(void) {
  // ... setup ...
  __module_init();   // synthesized; runs top-level statements
  ts_run_event_loop();
  return 0;
}
```

And `__module_init`'s body executes top-level statements in order. If the
top-level calls `main()` (as `main();` does in pattern 3), that's a normal
function call inside `__module_init`'s body.

If the file has NO non-declaration top-level statements (every existing
basic/exhaustive test under tsaot/), then no synthetic init is needed,
and the runtime entry still calls `main` if it exists — keeps current
behavior bit-exact.

### Concrete plan

1. In `buildIRFromSourceFile`, after lowering top-level function declarations,
   collect top-level statements that aren't pure declarations.

   "Pure declaration" means:
   - `FunctionDeclaration` (we lower these separately)
   - `ClassDeclaration` (handled separately too)
   - `InterfaceDeclaration` / `TypeAliasDeclaration` (erased at runtime)
   - `EnumDeclaration` (we treat as compile-time constants in many places;
     for runtime enums this gets more complex — for now, treat enums as
     "non-pure" and include them in the synthetic body when present)
   - Empty `EmptyStatement`
   - Bare `ExportDeclaration` of types

   Everything else is a "module statement" that goes into the synthetic body.

2. If module statements is empty, do nothing (current behavior).

3. Otherwise, create a synthetic FunctionLike with no params, body = the
   module statements, and lower it via `lowerFunctionLike`. Name it
   `__module_init`.

4. Modify `emit_c.rs` so that after `ts_register_classes()`, it calls
   `__module_init` first (if present), then calls `main` (if present).

5. Update `--transpile-batch`: today it appends `if (typeof main === 'function')
   main();`. Keep that (so pattern 1 still works), but DON'T do anything extra
   — Node naturally runs the top-level statements as the module body, so
   pattern 2-5 already behave correctly. The harness's V8 reference doesn't
   need to change.

### `function main` hoisting

JavaScript hoists function declarations: in pattern 3 above, the top-level
statement `main()` at line 5 sees the function declared at line 3-5 because
hoisting moves the declaration to the top of the module. We need the same in
the synthesized `__module_init`: when its body references `main`, the lookup
finds the lowered tsaot function id.

This is already handled by `funcSymbols` in the exporter — when we lower an
identifier that refers to a function declaration, it resolves to a function
reference. So no special hoisting work is needed; the existing identifier
resolution already does the right thing.

### Top-level `let` / `const` and lexical scope

In modules, top-level `let`/`const` are module-scoped, not hoisted as
variables. In `__module_init`, they become function-scoped locals. That
matches Node's behavior for these patterns: top-level `const x = 1; main();`
with `main` using `x` works in Node because the function-scope-lookup at
call time finds `x` in the module's top frame. In our model, calling `main()`
from `__module_init` doesn't share `__module_init`'s scope — `main` would
have to capture `x` via closure conversion.

But wait — `main` is declared at the top level, and `x` is also declared at
the top level. In tsaot's existing model, top-level `function main()` is its
own function with no enclosing scope. If we lower top-level `const x = 1` as
a local of `__module_init`, then `main`'s reference to `x` is a free variable
of `main`.

Two ways to handle this:

- **(F1) Treat top-level `let`/`const` as captures**: `cellBindings.add(x)`
  if `x` is referenced from a nested function. Then `main` captures `x` as a
  free variable. The standard closure-conversion path already exists and
  works.
- **(F2) Treat top-level `let`/`const` as module globals**: keep them in the
  existing `moduleVars` set (already populated by the exporter for `var`),
  and lower reads/writes as `LoadGlobal`/`StoreGlobal`.

F2 matches JavaScript semantics more accurately (top-level `let` IS in the
module scope, observable to all functions defined in the module). The
exporter already has `moduleVars` and `LoadGlobal`/`StoreGlobal`. Let me
check how `var` is handled today.

After investigation: today, top-level `var` declarations ARE collected into
`moduleVars` (in `assignIds`'s loop at line 287), and identifier resolution
routes module-var reads/writes through `LoadGlobal`/`StoreGlobal`. BUT the
top-level `var x = ...` ASSIGNMENT is silently dropped (since that's an
ExpressionStatement / VariableStatement at the top level, which the current
loop ignores).

So the fix is twofold:
- Generate `__module_init` to actually RUN the top-level statements (so
  initializers execute).
- Top-level `let`/`const` should be treated like top-level `var`: marked as
  module-scoped, accessed via `LoadGlobal`/`StoreGlobal` in nested functions.

That's two changes. For minimal risk, I'll do them in steps:

**Step 1**: synthesize `__module_init` that contains all non-declaration
top-level statements. Top-level `var x = 1` etc. get their initializers run.
For nested function references to `x`, the existing module-var path already
handles it (it generated `LoadGlobal` even before my fix, just that the
StoreGlobal that initializes it never ran).

**Step 2** (later, only if needed): extend module-var detection to also pick
up top-level `let`/`const`. For the conformance tests we care about, `var`
is overwhelmingly used (legacy style); start with Step 1 only.

### emit_c.rs change

```rust
let init_fn = program.functions.iter().find(|f| f.name.as_deref() == Some("__module_init"));
let user_main_fn = program.functions.iter().find(|f| f.name.as_deref() == Some("main"));
// ... existing setup ...
if let Some(f) = init_fn { writeln!(s, "  {}(0, 0);", cname(f)); }
if let Some(f) = user_main_fn { writeln!(s, "  {}(0, 0);", cname(f)); }
// (existing fallback: first function — keep for backwards compat? Actually
// the fallback was for files with no main; that case is now covered by
// __module_init being present. But to be safe, only fall back when neither
// is present.)
if init_fn.is_none() && user_main_fn.is_none() {
  if let Some(f) = program.functions.first() { writeln!(s, "  {}(0, 0);", cname(f)); }
}
```

### Risks

- A class declaration's static initializer or method-level code runs at
  class-definition time in JS. But TypeScript classes don't have JS-style
  side effects at declaration except via class fields and static blocks
  (which tsaot already has limited support for in the regular class
  lowering path). So a class declaration at top level is still a "pure"
  declaration for `__module_init` purposes — its methods run only on
  invocation. Static fields' initializers ARE side effects, but they
  belong to the class's own `__static_init` path (separate from
  `__module_init`).

- `ExportDeclaration` / `ImportDeclaration`: tsaot doesn't support
  modules. These should already be rejected or ignored. I'll skip them
  in the synthetic body builder.

- `EnumDeclaration`: in strict-mode TS, enums have runtime objects. Today
  tsaot's enum handling treats them as compile-time constants for member
  access. I'll skip enum declarations from the synthetic body — they're
  still erased at runtime.

- Existing `basic`/`exhaustive` tests: all of these use explicit
  `function main()` and have NO non-declaration top-level statements.
  The synthetic `__module_init` won't be generated for them. emit_c.rs's
  fallback "find main" remains the entry. **Zero behavior change for
  existing tests.**

### Test plan

1. New conformance test: `basic/toplevel_simple.ts`:
   ```ts
   console.log("hello");
   ```
   Expected output: `hello`.

2. New conformance test: `basic/toplevel_mixed.ts`:
   ```ts
   const x = 1;
   function add(a: number, b: number): number { return a + b; }
   console.log(add(x, 2));
   ```
   Expected output: `3`.

3. New conformance test: `basic/toplevel_then_main.ts`:
   ```ts
   const greeting = "hi";
   function main(): void { console.log(greeting); }
   main();
   ```
   Expected output: `hi` (the top-level `main()` call AND the synthesized
   `__module_init` running `main();` once). Wait — semantics: in Node, this
   prints "hi" ONCE because the top-level `main();` is the only call. With
   our synthesis, `__module_init` lowers the top-level statements, INCLUDING
   the `main();` call statement; the runtime entry then runs `__module_init`
   ONCE and then runs `main` ONCE (the existing entry behavior). That's
   "hi\nhi" — DIFFERS from Node!

   So the entry rule needs more care: when `__module_init` exists, the
   runtime entry should ONLY call `__module_init` (not also `main`). The
   user's explicit `main()` call inside `__module_init` is what produces
   the side effect. If the user wrote `function main()` but never called it
   themselves, no call happens — which matches Node (where `function main`
   defines but does not call).

   Revised emit_c.rs:
   ```rust
   if let Some(f) = init_fn {
     writeln!(s, "  {}(0, 0);", cname(f));   // ONLY init; user code chooses to call main or not
   } else if let Some(f) = user_main_fn {
     writeln!(s, "  {}(0, 0);", cname(f));   // legacy: no init means call main directly
   } else if let Some(f) = program.functions.first() {
     writeln!(s, "  {}(0, 0);", cname(f));   // ultimate fallback
   }
   ```

   But this BREAKS existing exhaustive tests! Their pattern is `function
   main()` with no top-level call to it. The runtime entry calls main
   because emit_c.rs's fallback picks it up. If we now synthesize
   `__module_init` for them... wait, we DON'T — they have no non-declaration
   top-level statements. The synthesis is skipped, init_fn is None,
   user_main_fn is Some(main), and we call main. Correct, unchanged.

   For the new test `toplevel_then_main.ts`: yes, both top-level statements
   AND `function main()` are present. We synthesize `__module_init`
   containing `const greeting = "hi";` AND `main();` (the call). Entry runs
   `__module_init` only. main is called from within init's body. Output:
   "hi". MATCHES Node. ✓

4. The 71 TypeScript conformance runtime tests should now actually exercise
   their code. Most will still REJECT (any types, unsupported features) but
   the cases that should work will.

## Plan summary

1. Add `__module_init` synthesis in `buildIRFromSourceFile`.
2. Update emit_c.rs entry point: call `__module_init` if present, else
   `main` if present, else the first function.
3. Add 3 new basic conformance tests (toplevel_simple, toplevel_mixed,
   toplevel_then_main).
4. Run FULL CI to confirm no regressions.
5. Re-run the tsc_conformance pilot to see the new pass rate.
6. Record findings.
