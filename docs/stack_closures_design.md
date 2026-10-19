# Stack-allocated non-escaping closures

## Data (Session 350, `native_s350x7`)

The analyzer's escape strategies annotate 1,368 allocation sites `Stack`,
639 `CallerArena` and 87 `FrameArena` in the compiler, but only class
instances with the `Stack` strategy are emitted as C stack structs: the
1,362 `Stack` closure sites, every arena site and the 6 `Stack` object
literals are heap allocations with a comment. The per-site statistics
build counted 5.6M closure allocations per compile; several of the hottest
sites are `Stack` (`captureErrorCalculationState`, `reportError`,
`isRelatedToWorker`, `reportIncompatibleCallSignatureReturn`, about 275k
each — the callbacks `isRelatedTo` passes to its helpers).

## Runtime facts the design relies on

- A cell with `gen == TS_GEN_NONHEAP` is referenced through a pointer
  tagged `TS_PTR_STACK_TAG`; `gc_mark_visit_slow` marks it, pushes it to
  the non-heap mark list and scans its contents, so the environment slots
  and the lazily created `prototype` of a stack function are traced and
  forwarded when a minor collection moves their young targets.
- The write barrier returns early for a pointer-form (stack) value and for
  a stack owner ("scanned as a root").
- A builtin call's arguments escape conservatively in the interprocedural
  summary (`C::Copy(Global, arg)`), so a callback handed to `then`,
  `setTimeout` or `bind` is never `Stack`; a `Stack` site is reached only
  by direct callees whose summaries do not retain the value, local calls
  and conditions.
- `Stack` is assigned only to single-shot sites since the loop-slot fix of
  this session (a loop-body site takes the frame arena).

## Design (`TSAOT_STACK_CLOSURES=0` keeps the heap allocation)

An `AllocClosure` whose site strategy is `Stack` emits, in place of
`ts_make_closure_t`/`ts_make_fn_t`:

```c
tsv senvN[k] = { cells... };                 /* k > 0 */
ts_func sfnN;
ts_init_fn_stack(&sfnN, (ts_code)fn_K, senvN, k, takes_this);
DST = ts_func_v(&sfnN);
ts_set_fn_meta(DST, ...); if (FN_HAS_PROTOTYPE[K]) ts_set_fn_prototype_lazy(DST);
```

`ts_init_fn_stack` (runtime) zeroes the struct and sets what
`ts_make_fn_impl` and `ts_make_closure_t` set: the header (`TS_KIND_FUNC`,
`TS_GEN_NONHEAP`, `sizeof(ts_func)`), the function prototype as `proto`,
`code`, `prototype_prop = undefined`, the environment pointer and length,
`env_abi` when the environment is non-empty, `takes_this`. `ts_func_v` on a
non-heap cell yields the stack-tagged reference. Everything else — calls
through `ts_call`/`ts_call_value`, direct calls that read `env` from the
closure, `call`/`apply`, metadata, the lazy prototype — works on the struct
through `ts_ptr`, which masks the tag. The cell is never swept, so its
environment array is never freed; its lifetime is the C scope of the
emitting function, which the `Stack` strategy guarantees to cover every
reference.

Fixture `closures/stack_closures`: callbacks passed to direct callees that
only call them (with and without captured cells), closures called locally,
conditionally created closures, a closure that creates a closure, recursion
through a local function, closures reading `.name`/`.length`, `call`/
`apply`, closures in try/catch, and a closure whose environment holds young
objects while the body allocates enough to force collections (the
environment must be forwarded).
