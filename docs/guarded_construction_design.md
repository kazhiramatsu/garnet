# Guarded direct construction (whole-program item 2)

Implemented in Session 350 (slice `x32`); exporter, emitter (three
static builtins) and runtime. Knob `TSAOT_NEW_GUARDS=0` disables it (the
parity oracle sets it); untyped mode (`TSAOT_UNTYPED=1`) never uses it.

## Finding

The parser creates every node with `new NodeConstructor(kind, pos, end)`
through a module variable assigned from `objectAllocator`; the checker
creates links with `new (NodeLinks as any)()`, symbols with
`new Symbol(flags, name)` and types with `new Type(checker, flags)`.
Each is a `new` through a function value, lowered to `NewDynamic` and
run by `ts_construct`: the constructor check, the prototype
materialization, the instance allocation with the learned slack, the
arguments copied into a stack array, the call through the function's
generic entry (boxed arguments unboxed again by the forwarder), the
slack bookkeeping and the object-return rule. The kernels
`ctor_functions` and `links_objects` run 2.95x and 3.36x slower than
Node; the profile attributes 36 inclusive samples to `ts_construct`, but
the parser's construction sites sit below the sampled depth.

## Design

The exporter predicts the constructor at each such site from the whole
program:

- the callee expression, through parentheses and assertions, names a
  function declaration with an explicit `this` parameter (`(NodeLinks as
  any)`, `Symbol`): that function;
- otherwise the site's instance type against the `this` type of every
  module-level function declaration with an explicit `this` parameter
  (assignable in either direction, so `Mutable<Node>` matches `Node`), with
  the parameter count of the site; at most six candidates, the one whose
  name prefixes the callee's (`NodeConstructor` → `Node`) first.

A site with candidates lowers to a guard chain. For each candidate:
`construct.sameCode(value, candidate)` compares the value's code pointer
with the candidate's (loaded from its function-value global; the value
must also be a plain constructable function); on a hit,
`construct.begin(value)` allocates the instance on the function's
prototype with the learned slack, the constructor body is called directly
with `this` = instance (the direct entry: typed parameters, module cells
threaded like any direct call), and `construct.end(value, instance,
result)` learns the slack and applies the object-return rule. A miss on
every candidate takes `NewDynamic` as before, so a class value, an arrow,
a rebound variable or any other value keeps the generic semantics,
including the catchable `TypeError`. A replaced `fn.prototype` is read at
every construction (`begin` materializes it as `ts_construct` does).

Candidates are limited to module-level functions because their
function-value globals exist from module initialization and the guard
loads them without allocating.

## Verification

Fixture `functions/guarded_construction`: a variable holding each of
three constructors in turn (the first candidate missing, another
hitting), an `any` callee, prototypes and `instanceof`, a class value and
an arrow in the same variable (generic path, the TypeError), constructors
returning an object or a primitive, slack-sized instances gaining fields
later, a prototype replaced after the first construction, thousands of
constructions through a parameter, and argument counts below and above
the parameters. Identical to V8, also under `TSAOT_GC_YOUNG_THRESHOLD=1`;
the knob reproduces the previous output. A `number`-typed parameter
that receives no argument reads as 0 on both paths (a pre-existing
deviation of the typed mode, recorded in the TODO and the known items).

## Results

Compiler A/B, `x32` against `x31`, two rounds of three alternating runs
(outputs validated, diagnostics zero): 5.434 vs 5.537 s median wall
(pairs +0.5%, -1.9%, -0.5%) and 5.528 vs 5.556 s (pairs -0.3%, -0.5%,
-0.8%); five of six pairs favor `x32`, about 0.5-1%. Node 3.29 / 3.37 s.
The compiler has 53 guards: the 15 parser sites against each of `Node`,
`Token` and `Identifier`, `Type` 2, `Symbol` 2, `Signature` 1,
`SourceMapSource` 2, `NodeLinks` 1 (its body inlined into
`getNodeLinks` between `begin` and `end`). Root pushes fall from 32.66M
to 30.75M per compile (the generic path rooted the arguments);
allocations and inline-cache counts are identical; the binary grows by
1.1 KB. Kernels: `ctor_functions` 2.95x -> 2.74x and `links_objects`
3.36x -> 3.30x slower than Node. The remaining cost of these sites is
the constructor body's stores (one shape transition and barrier per
field) and the instance allocation, which static slots (item 3) address.
