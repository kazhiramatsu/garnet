# General state-machine builder (yield/await in loops & conditionals)

## Problem
The v1 async/generator lowering splits the function body at TOP-LEVEL await/yield
only. A suspension inside a loop or `if` cannot be expressed by naive splitting:
after resuming we must re-enter the middle of a loop (with the counter advanced),
which C's structured `for`/`if` cannot jump into.

## Approach: flatten structured CF to labels+gotos, then switch-dispatch states
We lower the structured IR (If/Loop/Break/Continue + Await/Yield) of an async or
generator function into a FLAT instruction stream over **labels and gotos**, then
emit one `switch (state)` that can `goto` to any resume label. Because all locals
live in the coroutine frame (not C stack), jumping across state boundaries is
sound. This is exactly how LLVM coro-split and TS's __generator helper work.

### Flattening rules (structured IR -> flat ops)
Introduce flat pseudo-ops (codegen-only, not IR): Label(id), Goto(id),
GotoIfFalse(cond,id), plus the existing leaf insts, and Suspend(kind,operand,dst).
- If{cond,then,else}:
    GotoIfFalse(cond, L_else); <flatten then>; Goto(L_end);
    Label(L_else); <flatten else>; Label(L_end)
- Loop{cond_body,cond,body}:   (our Loop = `for(;;){cond_body; if(!cond)break; body}`)
    Label(L_top); <flatten cond_body>; GotoIfFalse(cond, L_end);
    <flatten body>; Goto(L_top); Label(L_end)
  Break -> Goto(L_end of nearest loop); Continue -> Goto(L_top of nearest loop).
- Await/Yield -> Suspend.
- TryCatch inside async/generator: v1 still rejected (setjmp/longjmp across a
  suspension is unsound); flatten only If/Loop/Break/Continue.

### State assignment
Walk the flat stream. State 0 starts at the top. Each Suspend ends the current
state and begins a new one (the resume point). Emit:
```c
switch (state) {
  case 0: goto S0;
  case 1: goto S1;        // resume labels
  ...
}
S0: ... ;                 // flat ops, including user labels Lk: and gotos
    // at a Suspend:
    state=1; <park: ts_await_register / set yielded>; return;
S1: <resume: read result/sent>; ...
```
Because every label (user Lk and state Sk) is a real C label and control uses
`goto`, a resume can land anywhere — including "inside" what was a loop.

### Locals
Already frame-resident in async/gen lowering (#define v{id} (_fr->v{id})). The
flat gotos reference the same frame fields, so loop counters etc. persist across
suspensions automatically. No extra spill logic needed.

### Codegen integration
Replace the body-splitting loop in emit_async_function / emit_generator_function
with: (1) flatten f.body -> Vec<Flat>; (2) assign states; (3) emit the dispatch
switch + the flat ops, where Suspend emits the park/return + next resume label.
Both async and generator share the flatten+state-assign; they differ only in what
Suspend emits (await_register+return vs set-yielded+return) and what Return emits
(promise_resolve vs done=1).

### Safety
- C `goto` cannot jump INTO a variable's scope past its initializer in C++, but
  this is C and all locals are frame fields declared up front -> safe.
- Labels must be unique per function; we prefix with the function name.
- A `goto` into the middle of a previously-`for`-structured region is fine since
  we no longer emit `for`; everything is goto-based in async/gen functions.
- Nested loops/ifs: a stack of (L_top,L_end) per loop resolves Break/Continue to
  the nearest enclosing loop, matching JS semantics for unlabeled break/continue.
