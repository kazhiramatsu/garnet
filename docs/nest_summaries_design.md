# Summaries for large recursion nests

Implemented in Session 350 (build `x49`); analyzer only (`interproc.rs`).
Everything here is active only in the phantom mode of `x48`
(`TSAOT_ESCAPE_PHANTOMS=0`, the parity oracle's mode, keeps the previous
analysis byte for byte); `TSAOT_NEST_MAX=128` restores the skip of large
nests alone.

## Finding

The interprocedural analysis summarizes functions bottom-up over the
call graph's strongly connected components and iterates a recursion nest
to a fixpoint, but a nest with more than 128 members got no summaries at
all: the checker's nested functions form one nest of 1,640 members (the
parser's 242 and another of 209 as well), so every argument of every call
into the checker escaped globally: the callbacks of `mapType`,
`filterType` and `forEachType`, the scope records passed to the nested
helpers, the arrays handed to `getUnionType`. A plain fixpoint over the
1,640 members did not converge in 13k solves (eight per member) and a
solve took up to a minute; three things fed the blow-up:

- The summaries carried the callee's whole internal object graph
  (`Internal -> Internal` edges), thousands of entries per hub function,
  which the callers only use to read fields of a returned opaque object.
- Stores into the contents of a parameter's field, which `x48` reported
  with their base path (`ParamField(i, f)`), accumulated transitively:
  twelve thousand entries in `getTypeOfNode`'s summary, each translated
  into a load and a store at every call site.
- The checker's scope record (2,251 captured bindings) is a parameter of
  every nested function; per-binding facts about its contents cost
  hundreds of constraints per call site.

## Change

- A store into the contents of a parameter (one or more loads deep) is a
  global escape of the stored value. The emitter does not distinguish
  `ArgEscape` from `GlobalEscape` (there is no caller arena), so the path
  precision of `x48` bought nothing at run time; the summaries lose their
  `ParamField` bases and the solver its phantom links. A parameter whose
  contents two or more loads deep reach the global sink is reported
  (`deep_global`) and the caller marks the whole actual global; one-level
  contents keep the precise `field_global` / `field_ret`.
- A summary says whether any object of the callee's own reaches the global
  sink (`internal_global`); the caller's opaque node is then global. The
  previous summaries transmitted this only through a store into an
  external object, which missed a callee that handed its object to an
  unknown callee.
- Members of a recursion nest take *compact* summaries: only the edges that
  touch a parameter are kept, and the caller reads the internals of the
  opaque node as external (`AddrField(op, Dynamic, External)`, consulted by
  every load), which over-approximates the full summary.
- A scope record with more than 64 fields (`TSAOT_RECORD_EXTERNAL_FIELDS`;
  four in the compiler: the checker, the parser, the node factory, the
  module record) is an external object: its allocation escapes, its
  contents are global, and the parameters that receive it are external.
  Such records live for the whole program anyway.
- The nest's worklist pops members in a postorder of the nest's own call
  edges (callees first); a change in a callee is consumed by its callers
  after the other pending callees. A member of a nest above 128 members
  whose summary still changes at its sixth solve (`SCC_LARGE_NEST_WIDEN_AT`,
  `TSAOT_NEST_WIDEN`) is widened to the conservative summary and not
  solved again; smaller nests keep the previous budget rule, since widening
  them demoted converging members (the binder's `bindEach` callbacks).
  The nest cap is 4,096 members in the phantom mode.

## Verification

The lifetime-attack fixtures (`closures/param_contents_lifetimes`, the
scratch attacks of `x48`) identical to V8 and under `TSAOT_GC_YOUNG_THRESHOLD=1`;
the decision report of the old mode byte-identical to `x47`'s; unit,
parity, bundler, selfconf, GC stress, inline policy and conformance; the
compiler A/B (`x49` against `x48`) in the TODO entry.

## Results

The 1,640-member nest converges in 7,863 solves (18 s; 582 members
widened, 1,058 precise), the 242- and 209-member nests in 513 and 426
solves with 2 and 0 widened; analysis of the compiler 8.8 s -> 27 s.
Decision report, count-weighted by the per-site statistics of `x47`:
closures 220k per compile Heap -> Stack at 37 sites (`mapType`,
`filterType`, `getTypeWithFacts`, `getApparentTypeOfContextualType`
callbacks), none Stack -> Heap with a nonzero count; scope records now
`NoEscape` for 983k allocations per compile (still heap: the cell rule),
arrays and literals unchanged (no stack or arena representation yet).
