# Frame elision: no shadow frame where no reference outlives a collection point

## 1. Measurement

One compile of the compiler pushes 390.8M shadow frames (statistics build,
`root_frames: frame_push`); 9,788 of its 11,353 generated functions push one
at entry. A push and its pop store the frame header, the global frame top
and every slot's initial value: about ten instructions, some 4% of the
compile's instructions. A frame exists so that a collection finds the
function's reference locals and rewrites them; a local that never holds a
value across a point where a collection can happen does not need one.

The pattern kernel `small_calls` (3.4x Node) shows the shape:
`function isRef(t) { return (getObjectFlags(t) & 4) !== 0; }` pushes a frame
for `t`, which is only passed to the call.

## 2. Rule

A reference local of a function needs a frame slot when a collection can
happen while it holds a value that is read afterwards:

- collection points are the leaf instructions that may allocate or run user
  code: everything but constants, copies, returns, jumps, globals, lengths,
  `!` / `typeof` / nullish tests, strict (in)equality, and arithmetic on
  unboxed operands (the set `body_is_gc_free` already accepts);
- over the linear positions of the frame-layout walk (`LiveWalk`: the first
  definition, the last use, a use inside a loop extended to the loop's end),
  a local is live across a point strictly between its definition and its
  last use;
- a point at the last use counts too, unless that use passes the value to a
  direct call of a generated function's direct entry (`direct_entry_eligible`:
  not async, not a generator, no rest parameter, no `arguments`): the value
  arrives as a C parameter and the callee's own rule gives the parameter a
  slot when it needs one. Any other callee (the runtime, an indirect call, a
  method set, a generic entry that gathers a rest array) may rely on the
  caller's slot, as it does today;
- a local the walk cannot place (used before its definition in linear order:
  a value carried around a loop) needs a slot if the function has any
  collection point.

A function with no local needing a slot pushes no frame; its other
reference locals are plain C locals. Unchanged (every reference local keeps
its slot):

- lazy frames (bodies whose only way into the runtime is an inline-cache
  slow path: already no push on the fast path);
- functions with a `try`: a throw from anywhere in the try body reaches the
  catch or finally body, which reads locals after the `longjmp` (a C local
  written after the `setjmp` would also be indeterminate there);
- functions with JSON DOM locals or scalar string slices (their values
  materialize at uses), and functions whose string plans replace whole loops
  by fused code (the fused code reads locals at places the instruction walk
  does not see);
- string accumulators: `return` finishes the builder (`ts_sb_finish`), a
  collection point the walk does not see, so their locals keep slots;
- the root-stack mode (`TSAOT_FRAME_ROOTS=0`, the parity oracle's).

`TSAOT_FRAME_ELISION=0` keeps every frame.

## 3. Verification

The rule is about liveness under handles: a value left unrooted can be
freed by a collection and its handle reused, and a promoted cell's slots are
rewritten only where the collector finds them. The GC stress gate (a minor
collection at every allocation, ASan, protect mode) runs the focused set;
the whole conformance suite also runs with a collection at every allocation
in protect mode; the compiler compiles itself under protect mode, with
zapping, and with a minor collection every 256 allocations, its output
compared with the reference. Fixture `gc/frame_elision` covers a reference
passed only to a direct call, one passed to a direct call and read
afterwards, one passed to the runtime at its last use, loop-carried
references, a reference read in a catch after a throwing call, a definition
late in a loop body read early in the next iteration, `this` through a
method that allocates, a getter between uses, captured cells, a direct call
with extra arguments, rest and `arguments` callees, a returned string
accumulator, and arguments evaluated around an allocation.

## 4. Results

On the compiler 668 of 9,788 frames disappear and the others lose slots;
frame pushes fall from 390.8M to 360.7M per compile. Eight ABBA pairs
against the previous build: instructions -1.53% (eight of eight), cycles
-1.55%, wall -1.5%. Kernel `small_calls` 726 -> 686 ms.

A per-function count of the remaining pushes, joined with the rule under
relaxations, says where the rest is:

| relaxation | pushes removed |
|---|---|
| precise backward liveness (never needs a slot the walk does not, on all 9,753 functions) | 1.4% |
| frames linked only around inline-cache slow paths when no other collection point has a live reference | 12.9% |
| comparisons whose operands cannot be objects | 2.9% |
| builtins that never allocate (upper bound: all builtins) | 6.5% |
| direct callees that never collect (228 functions) | 4.2% |
| together | 28% |

The other 72% are in functions with a reference live across a real call on
some path; there only linking the frame at the first point that needs it
would help (many calls return through flag tests before any call).
