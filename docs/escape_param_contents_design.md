# Escape analysis: stores through a parameter's contents

Implemented in Session 350 (build `x48`); analyzer only (`interproc.rs`).
Knob `TSAOT_ESCAPE_PHANTOMS=0` restores the previous analysis (the parity
oracle sets it on its Rust emitter line).

## Finding

A lifetime attack on the escape strategies (the Session 350 note on
their soundness asked for exactly this) found two holes in the
interprocedural analysis, both silent miscompiles:

- A value stored into the contents of a parameter's field was invisible.
  `function f(reg: Registry, i) { const b = new Box(i); reg.list.push(b) }`
  loads `reg.list` into the phantom node `ParamField(reg, list)`, the push
  stores `b` under that phantom, but nothing reached the phantom from the
  parameter, so `b` was `NoEscape` and a class instance or closure at such
  a site was emitted as a C stack struct: the caller later read freed stack
  (`NaN` for `reg.list[0].v`, or a crash).
- A load from a phantom (`h.reg.list`), from an external object (a global,
  an opaque return) or from a dynamically stored field yielded nothing, so a
  store through it was lost in the same way.

The summary side had the same two gaps: a callee that stores into the
contents of a parameter reported the store under `Internal` (its own
objects), so the caller never learned that its object had grown a
reference.

## Change

- A phantom is linked under the object it was loaded from
  (`Solver::link`): the field map records `ParamField(p, f)` as a value of
  `Param(p).f`, so the argument and global closures descend into the
  caller-provided contents and whatever the function stores into them. A
  link is structure, not a store; it is kept in `Solver::links` and left out
  of the summary.
- A load two or more deep under a parameter yields `ParamDeep(p)`, one
  node per parameter (the path is lost), linked the same way. A load from
  `External` yields `External`. A dynamic store (`o[k] = v`) is recorded
  under the new `FieldKey::Dynamic`, which every load consults.
- Summaries name the base of such a store: `SObj::ParamField(i, f)` is
  translated at the call site as a load of the actual's field followed by
  the store into its contents, and `SObj::ParamDeep(i)` as a store to the
  global sink (the path is unknown; the caller's structure may be global).
  A phantom used as a stored *value* or a return is collapsed to `External`:
  keeping phantom values distinct made the points-to sets of the
  configuration and module-resolution functions explode (millions of
  entries, five minutes of analysis); one-level returns are already
  covered by `field_ret`.
- A function whose constraint set exceeds `TSAOT_ESCAPE_MAX_CONSTRAINTS`
  (200k) is not solved: every site of it escapes and its summary is
  conservative. The compiler's `__module_init` builds 400k constraints with
  the links and took seven seconds per solve; its allocations are module
  lifetime anyway.

## Verification

Fixture `closures/param_contents_lifetimes`: a class instance, an object
literal, an array and closures stored one load deep (`reg.list.push`),
two loads deep (`h.reg.list.push`), through an element of a parameter array,
through an opaque return value, into a module-level object, through `this`
in a method, as a closure on a parameter's field, retained through an inner
closure that an opaque helper keeps, returned inside a fresh object, after
a dynamic-key store, and a callback that is only called; 300k allocations
between the stores and the reads force collections. Identical to V8, also
under `TSAOT_GC_YOUNG_THRESHOLD=1`; with the knob off the native binary
prints nothing (the crash the fix removes). The closure, capture,
stack-closure and allocation-lifetime fixtures unchanged; unit, parity (the
old mode is byte-identical in the decision report), GC stress, conformance.

## Results

Decision report of the compiler (`x47` program, count-weighted by the
per-site statistics): closures 91k per compile Heap -> Stack (32 sites,
callbacks to `filterType` and friends: the previous summaries collapsed a
callee's escaping arrays and its non-escaping inner closure into one node),
no site Stack -> Heap with a nonzero count; arrays and cells unchanged.
Analysis of the compiler 2.8 s -> 8.8 s. The compiler A/B (`x48` against
`x47`) is in the TODO entry.

## Refinement: deep phantoms per field, loads into primitives (`x52`)

Probing the stack-record fixture (`x51`) showed a closure that reads a
captured object's numeric field (`last ? last.v : 0`) sending the whole
record to the heap: the two-deep phantom carried no path, so its escape
(the `+` materialization of a loaded operand marks it global) was
reported as the escape of the entire parameter (`deep_global`), and the
record captured by the closure became global at creation. Two changes:

- `ParamDeep(p, f)` is one node per (parameter, first field): a load from
  `ParamField(p, f)` or from `ParamDeep(p, f)` yields `ParamDeep(p, f)`,
  and its escape is reported as the escape of the field's contents
  (`field_global (i, f)`), which the caller translates as a load of the
  actual's field plus a copy to the sink: the contents of `rec.last` go
  global, the record does not. The path below the first field is still
  lost, and stores into any phantom still go to the global sink.
- A load into a primitive-kind local (a `number` field in typed mode)
  carries no reference and emits no constraint, so no phantom is created
  for it at all; the old mode keeps the constraint.

Decision report, count-weighted: records a further 64k per compile Heap
-> Stack (`getSignatureApplicabilityError` 57k), arrays 101k Heap ->
FrameArena and 44k Heap -> CallerArena (`[type, missingOrUndefined]` in
`getOptionalType`, `[mapped]` in `mapType`: now `NoEscape` / `ArgEscape`,
still heap allocations until arrays have a stack or arena form), closures
unchanged. Analysis of the compiler unchanged (27 s).

## Soundness: aliases handed back to the caller (`x53`)

The fixtures above attack one direction: a callee storing its own object
into the caller's structure. The other direction, a callee handing the
caller's own object back to it, had four holes, all silent miscompiles that
predate `x52` (a class instance at the caller's site is a C stack struct;
the caller kept the alias in a module array and read it after the frame was
gone, or SROA read a dead local):

1. **A phantom handed back as a value.** The summary collapses a phantom
   stored as a value or returned to `External` (the explosion noted under
   Change), and `field_ret` covered only a one-load phantom that is itself
   the return value. A return two loads deep (`return p.a.b`), an element
   (`return p[0].b`), a store into a field of another parameter, of the same
   parameter or of `this` (`q.x = p.a`, `p.c = p.a`, `this.x = p.a`), or a
   fresh object or array wrapping the contents (`return { v: p.a }`,
   `[p.a]`) gave the caller an alias it read as `External`, so its own
   object stayed `NoEscape`. Now every phantom stored into an object the
   caller reaches after the call (the field closure of the return value and
   of the parameter objects), and every phantom returned two or more loads
   deep, is reported as `field_global` of its (parameter, first field): the
   contents and everything below them escape. `field_ret` keeps the
   precise one-load return (the old mode keeps its rule).
2. **Compact summaries** (recursion nests, `x49`) dropped the edges between
   two internal objects, so a parameter stored two fresh objects deep
   (`return { v: { w: p } }` in a recursive function) was read back as
   `External`. A compact summary now keeps one collapsed
   `(Internal, Dynamic, Internal)` edge.
3. **A closure's creation.** Whoever invokes the closure receives its
   return, but only a returned capture parameter was folded to the sink at
   creation (`x50`): a fresh object or array wrapping a captured value
   (`() => ({ v: b })`, `() => [b]`, also called through a helper or
   returned by another closure) left `b` on the stack, and a store whose
   base is a declared parameter (`(q) => { q.x = b; }`) was dropped (that
   parameter has no actual at creation). At creation a returned internal
   object now goes to the global sink with everything stored into it, and a
   declared parameter as a store base is an `External` object.
4. **SROA** (`sroa.rs`, not the escape analysis): an allocation whose local,
   or a copy alias of it, has another definition (`let b = new B(i); if (c)
   b = new B(0); return b.v`, the same through `switch`, `catch`, loops, a
   closure's assignment, a reassigned parameter) was scalar-replaced. The
   alias maps are flow-insensitive and keep one source per local, so the
   read after the join used the first allocation's fields whichever path
   ran, or read the never-assigned local (a `TypeError` or a crash when the
   local reached a closure). A local with more than one definition (a catch
   binding counts), and every source copied into it, now keeps its object;
   at the top level the parameters count as defined at entry.

Not a lifetime issue, seen while probing: `const n: number = p.a` with
`p.a: any` holding an object unboxes the value in typed mode (`ts_num`
canonicalizes a NaN that looks boxed), so V8 keeps the object and garnet a
NaN; typed mode trusts the annotation, as with the other `number` items in
`CLAUDE.md`. It also means a reference cannot survive a primitive local,
which the `x52` rule relies on.

Verification: fixtures `closures/alias_handback_lifetimes` (twenty cases,
heap churn between rounds) and `classes/sroa_reassigned_merge` (thirteen
shapes over five inputs) are identical to V8, also under
`TSAOT_GC_YOUNG_THRESHOLD=1` (914k minor collections); built with each of
the four fixes removed alone, one of the two fixtures fails. The old
mode's decision report is byte-identical. Decision report of the compiler,
count-weighted: unchanged (14 sites with a zero count flip in both
directions, from the nest's changed widening: 7,697 solves, 506 widened);
analysis 27 s.
