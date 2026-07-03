# ts_rt + C codegen — lightweight JS runtime & code generation

Goal: emit C that runs the typed/analyzed parts of a TS program as native code,
falling back to a small JS runtime (`ts_rt`) only for the dynamic parts. What
makes us faster than V8 is that escape + type + devirt analysis remove most of
the runtime's work *before* codegen; the runtime is the floor, not the path.

## What we took from v7 (and what we deliberately didn't)
v7 (cesanta) is a tiny embedded JS *interpreter*: parser + bytecode VM, every
value NaN-boxed, every object a hash map, every property access a dynamic lookup.
We borrow exactly one idea — **NaN-boxing** as the universal tagged value — and
reject the rest, because we are an **AOT compiler with static analysis**:

| concern | v7 (interpreter) | ts_rt + codegen (AOT) |
|---|---|---|
| value rep | NaN-boxed `v7_val_t` everywhere | NaN-boxed `tsv` **only on the dynamic path**; typed code uses `double`/structs |
| objects | always hash map | C struct + fixed offsets when shape is known; map only for `any` |
| dispatch | always property lookup | direct/vtable when devirt proves it; dynamic only otherwise |
| execution | bytecode VM | native C via gcc/clang |
| GC | mark-sweep over all values | mark-sweep over the *residual* heap (most allocs are stack/arena) |

## NaN-boxing (`ts_rt.h`)
A 64-bit double is a number unless its top 16 bits form a quiet-NaN selector
`0xFFF8..0xFFFD` (sign+exp+quiet+3-bit tag), leaving a 48-bit payload for
pointers/immediates. Numbers pass through untouched (zero-cost); arithmetic NaNs
are canonicalized to `0x7FF8…` so they never alias a boxed selector. Tags:
object / string / func / bool / undefined / null. 24 runtime unit tests +
edge tests (−0, ±inf, NaN, 48-bit pointer round-trip) pass (`ts_rt_test.c`).

## Runtime (`ts_rt.c`) — deliberately small
- **Object model** (dynamic fallback): open-addressed property map with a
  prototype link, behind a common GC header (`kind`,`mark`,`gc_next`).
- **Strings**: length+FNV-hash+inline bytes; `+` and `===` specialized.
- **Operators**: `ts_add` (numeric add / string concat), `ts_strict_eq`,
  `ts_truthy`, `ts_to_string_v`, `ts_print`.
- **GC**: precise mark/sweep over the residual heap, rooted via an explicit root
  stack (`ts_gc_root`/`ts_gc_unroot`). Because escape analysis stack/arena-
  allocates the NoEscape majority, the collector sees few objects → a simple
  collector suffices (this is the whole point of the analysis pipeline).

## Specialized vs dynamic emission
The emitted-C *shape* for classes (hand-validated in `aot_emitted_demo.c`,
prints 21.5664 / 12.5664 / 42):
- **prefix-layout structs**: `struct Circle { Shape base; double r; }` — inherited
  fields at constant offsets; vtable pointer in the header.
- **per-class vtables**: `area` in slot 0; overrides reuse the slot; virtual call
  is `obj->vt->area(obj)` (O(1), lowers to `jmp *(%rax)`).
- **devirtualized direct calls**: receiver statically known (RTA mono) → direct,
  inlinable C call.
- **stack allocation**: NoEscape + determinable + once → a C local struct, no heap.
- **dynamic fallback**: `any`/unstable/escaping → `tsv` + `ts_new_object` +
  `ts_get`/`ts_set` + dynamic dispatch.

## emit_c.rs (the working slice)
Consumes the analyzed `Program` + `EscapeResult`: emits one `tsv` local per IR
local, roots ref-like locals, lowers each `Inst` (AllocObject→`ts_new_object`
annotated with its escape strategy, Load/StoreField→`ts_get`/`ts_set`,
Direct/Set calls→`FN_TABLE` dispatch, Return with GC unroot). It is **total**
(compilable C for any IR) and already threads the per-site strategy
(`site 100 Stack` in the output). End-to-end verified: IR → devirt → escape →
emit C → gcc → native binary round-trips `42` and `hello` through the runtime.

## Status & next steps
Working: NaN-boxed runtime + GC (tested), the target emitted-C shape for
classes (compiles & runs), and a total dynamic-path emitter wired through the
full analysis pipeline to a running native binary.
Next, to realize the speed thesis:
1. **Promote the specialized path in emit_c**: emit prefix structs + vtables +
   stack allocation for stable/determinable classes (the demo shape), keeping
   `tsv` only where analysis says dynamic.
2. **Typed numeric path**: keep `double`/`int` unboxed through arithmetic
   (int/range specialization) instead of `tsv` round-trips.
3. **Arena allocation** for NoEscape-many / ArgEscape (bumpalo-style region).
4. **Builtins** (`console`, `Array`, `Math`) and exceptions via `Result`-style
   threading.
5. **Cycle handling** is already covered by mark/sweep (not refcounting).
