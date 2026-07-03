# class vtable + devirtualization — design & JS-semantics guards

TS classes are JS classes: prototype-based, runtime-mutable, and reachable via
`any`. A static vtable/fixed layout is sound only for a *closed, stable* slice of
the hierarchy. This is enforced as a first-class decision in `classes.rs`.

## Layout (single-inheritance, C++-style)
- Object header slot 0 = vtable pointer; instance fields follow in a **fixed
  prefix**: a subclass's fields extend the parent's, so a supertype-typed
  reference reads any inherited field at a constant offset. (`field_offset`)
- **vtable**: one slot per method *name*, assigned at the name's introduction and
  **stable across the hierarchy**; an override reuses the parent's slot, a new
  method appends. (`vtable`, `slot_of`)

## Dispatch decision (`devirtualize`)
For `recv: StaticClass . m`, over the closed-world subtree:
- **Direct(f)** — exactly one reachable implementation (CHA; refined by RTA to
  only-instantiated classes): emit a direct, inlinable call.
- **Virtual{slot}** — several implementations: `obj->vt[slot](obj, ..)`, O(1)
  regardless of subclass count (verified: lowers to `jmp *(%rax)`).
- **Dynamic** — see guards: emit a runtime prototype-chain / IC lookup.
- `super.m()` is always **Direct** (the target is statically the parent's
  resolution). (`super_dispatch`)

## Soundness guards (what makes it correct under JS semantics)
A call falls back to **Dynamic** when any of these hold:
- **receiver via `any`/cast** (`recv_stable=false`): the runtime value may not
  have the declared shape — a fixed-slot read would corrupt memory.
- **unstable class** (`stable=false`): prototype mutated (`C.prototype.m = …`,
  `setPrototypeOf`, `delete`), dynamic property add, or method reassignment seen.
- **unstable candidate** anywhere in the reachable subtree.
Accessors are dispatched as methods, not field loads (`member_kind` distinguishes
Field / Getter / Setter / Method); private `#fields` are ideal fixed-layout
members (truly own, non-patchable from outside).

## Integration plan (exporter + pipeline)
1. **Extract `ClassInfo`** from the TS AST: parent, own methods (incl. get/set,
   overrides), own fields (class fields + constructor `this.x=` with a *stable*
   key set), `instantiated` (any `new C`), and run a **stability analysis** that
   sets `stable=false` on classes touched by prototype mutation, `setPrototypeOf`,
   dynamic property writes, method reassignment, or `any`-typed access (a
   shape-stability analysis, sibling of the escape analysis).
2. Exporter emits method calls as `CalleeRef::Method{ recvClass, name }` plus a
   per-site `recvStable` flag.
3. A **devirt pass** runs before escape analysis: it computes `Dispatch` (codegen
   output) and lowers each `Method` call to `Direct{func}` / `Set{funcs}` /
   `Unknown` so the existing escape analyzer consumes it unchanged.
4. **Codegen** emits prefix-layout structs, per-class vtables, Direct/Virtual/
   Dynamic calls, and (for NoEscape + determinable + stable) stack allocation —
   composing with the escape/codegen tiers.

## Status
`classes.rs` implements layout + CHA/RTA devirt + guards (23 unit scenarios pass,
`classes_tests.rs`). `aot_classdemo.c` shows emitted vtable dispatch + a
devirtualized direct call running correctly. Remaining: exporter ClassInfo
extraction + stability analysis, and wiring the devirt pass into the IR pipeline.
