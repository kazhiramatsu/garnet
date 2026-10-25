# Startup: the module initialization

Session 353. tsc-ts's `--version` takes 9.0 ms against scriptc's 5.3; from
the host's init to main.ts's first line (the module initialization, every
module's top-level code) garnet takes 4.8 ms against 1.3. The difference is
the whole startup gap, paid once per run (workers fork from the initialized
parent): 0.4% of a one-checker compile, 0.8% at ten checkers, where the parse
workers are also forked only after it, and most of a short command.

## Where the time goes

A 20 µs sampling profile of `--version` (five runs):

- the module initialization's own code: 40% of the in-process samples. It is
  one C function, `__module_init`, synthesized from every module's top-level
  statements (the exporter's single scope): 148,648 lines, 30,623
  function-scope variables, compiled at `-O0` as a cold unit because
  optimizing it does not finish (`-O1`: 5 CPU minutes and 7.5 GB, abandoned);
- the runtime it calls to define things: 30% (`props_define`,
  `ts_set_named_prop`, `shape_desc_record`, `ts_register_class`,
  `ts_intern_field`, `lit_layout_shape`, `ts_setup_prototypes`);
- inside the function, about 10,000 stores build constant arrays element by
  element from an empty array (the scanner's Unicode identifier ranges and
  other tables), and 30k locals are initialized at entry.

## S1: the module initialization split for optimization

The unit splitter (`analyzer/src/c_units.rs`) cuts a cold function of the
module initialization's shape into chunk functions of about
`TSAOT_UNIT_INIT_CHUNK_LINES` (1,000) lines each, compiled like any other
unit (`-O2`, ThinLTO, the profile), and leaves the function itself as a
caller of the chunks. The one-file emit (stdout) is unchanged, so the parity
oracle and small programs are too.

- **The shape.** `tsv NAME(void){`, a prologue of plain declarations with
  constant initializers (`TYPE NAME = INIT;`: they move to the chunk that
  uses them, so no side effect may move with them), the frame when there is
  one (`struct { ts_frame_hdr h; … } F;`, its slots' initializations,
  `ts_frame_push(&F.h, N);`; a small program's initialization has none), the
  body, and the epilogue (`ts_frame_pop(&F.h);` when framed, then
  `return TS_UNDEFINED;`). No `return` in the body. Anything else keeps the
  function whole in its cold unit.
- **The cuts.** After a line that ends a statement at brace and parenthesis
  depth 0 (a trailing comment ignored), every chunk-size lines: never inside
  a label's span (the label and its `goto`s), never before an `else` or a
  `while` that continues the statement, and never between a depth-0
  `static` or a non-scalar declaration and its last use (those spans are
  closed to cuts, like a label's).
- **The variables.** A function-scope variable (the prologue's, or a depth-0
  declaration in the body) used by one chunk is declared in that chunk with
  its initializer: the chunks run once, in order, so it starts as it did. A
  variable used by several chunks is a field of a struct on the caller's
  stack, reached through a pointer (`mi__s->name`); a depth-0 declaration of
  one becomes an assignment. The frame is the caller's, reached through a
  pointer (`mi__f->sN`). A variable whose address is taken, or of a struct
  type (an object the escape analysis put on the stack), lives in the shared
  struct whatever its users: a pointer to it (in a frame slot, a root,
  another object) may be used by a later chunk. A declaration that cannot
  be shared (several declarators, or several statements on its line, such as
  a modulo's two operands before its test, or a static) stays in one chunk
  with its uses; one of them that is an automatic array, or whose address is
  taken without being static, keeps the function whole (a pointer to it
  could outlive its chunk; an array decays to one unseen). A nested
  declaration that shadows a function-scope name keeps the function whole.
- **The chunks** are `__attribute__((noinline))` (ThinLTO would inline a
  function called once and rebuild the giant function), take two `void*`
  and declare the two struct types at block scope, so the shared header
  needs nothing new. They go into `init_<name>_<k>.c` units of about
  `TSAOT_UNIT_CHUNK_LINES` lines, the caller into the first.
- **The collector.** The shared struct and the frame live on the caller's C
  stack, which the conservative scan covers; a chunk's own variables live in
  its registers and stack, as every optimized function's do. A value a later
  chunk needs is shared, so it stays on the caller's stack.
- `TSAOT_UNIT_SPLIT_INIT=0` keeps the function whole.

Prototype (a script over tsc-ts's generated C): 118 chunks of 1,000 lines,
57 shared variables; `-O2` compiles them in 34 s (3,000-line chunks: 55 s,
the same speed); the module initialization 4.6 to 3.2 ms, `--version` 7.8
to 6.4 ms; outputs identical.

### S1 as built

As designed, with three measured changes:

- **The chunks' units are native objects at -O1** (`init_<name>_<k>.c`;
  `scripts/lib/units.sh`, `TSAOT_UNITS_INIT_OPT`), and a profile-generating
  build compiles them like the cold units, at -O0 and uninstrumented. As
  ThinLTO units with the profile they started 0.6 ms sooner but cost the
  build 78 CPU seconds (the link-time code generation of 6 MB of C and the
  instrumented compile); as native -O1 objects the build costs 25 CPU
  seconds more than with the cold unit (tsc-ts: 144 to 156 s of wall time,
  500 to 525 CPU seconds, three jobs).
- **The init units call the originals** like the cold units: as ordinary
  units they took the small functions' inline copies, which turned the
  functions those copies reach from static to extern and changed 28 other
  units and the header. Now every other unit is byte for byte what it was.
- **The chunks' prototypes live in the caller's unit**, not in the shared
  header, so the header does not change with the number of chunks.
- **Any cold function of the shape is split**, not only the module
  initialization: a large `main()` without parameters has it too.
- **Stack objects.** The first version kept a variable used by one chunk in
  that chunk even when its address was taken; the conformance suite run
  through units with the split forced on every program (chunks of 8 lines)
  failed 30 of 575 fixtures, empty or wrong output: an object the escape
  analysis put on the stack (`Class0 sobj9;`) was initialized in one chunk
  and its address, stored in a frame slot, used by the next after the first
  had returned. tsc-ts's initialization has two such objects; its outputs
  were identical only because each stayed within one chunk.

tsc-ts: 118 chunks in 8 units, 57 variables shared. Measured on trained
builds, interleaved (`--version` and the module initialization over 25 runs,
the compiles over 5):

| | cold unit (-O0) | split, -O1 native | split, ThinLTO + profile |
|---|---|---|---|
| module initialization | 4.73 ms | 3.56 ms | 2.95 ms |
| `--version` | 8.00 ms | 6.80 ms | 6.23 ms |
| one checker | 969 ms | 954 ms (0.984) | |
| build, wall / CPU | 144 / 500 s | 156 / 525 s | 161 / 578 s |

The one-checker compile is faster in every phase, not only at startup
(instructions 0.979, cycles 0.987; the parse, check and emit phases each 1
to 2% shorter by tsc-ts's timeline). This was not traced; the -O0 function
kept its 30,623 variables, and the objects they referenced, alive on the
stack for the whole initialization, which is one candidate. Ten checkers:
within the noise. Outputs identical at one, four and ten checkers. The final
build (the stack-object and declaration rules below; same speed): module
initialization 4.91 to 3.62 ms against scriptc's 1.37, `--version` 8.25 to
7.00 ms against 5.34, one checker instructions 0.977 (a loaded machine).

## S2: constant arrays from static tables

An array literal of numeric constants above a size threshold becomes one IR
instruction the emitter writes as a static table copied into an array of the
right capacity. Removes the element-by-element stores and the array's growth.

## S3: the runtime's definitions at startup

The 30% in property definition, shape creation, interning and class
registration: precomputed shape chains or intern tables for the large
top-level objects, measured first.

### S3 as built: the transition table pre-sized

A 20 µs profile of the split build's startup (30 runs merged by file
address): shape transitions 17% (`props_define`'s lookup or creation 7.9%,
`lit_layout_shape`'s walk 5.2%, the transition table's rehashing 3.7%), the
property lookups before an addition 11%, class registration 3.3%,
interning 2.5%. `props_define` is called almost only from
`ts_define_data`, and `ts_define_data` almost only from the generated
`ts_setup_prototypes` (10,655 method definitions, one new shape each, still
a cold -O0 unit); `ts_set_named_prop` from inline-cache misses (a run-once
site always misses).

The transition table started at 64 slots and doubled at three quarters
full, rehashing every edge on the way to 16,384: it now starts at 16,384
(256 KB of zero pages until touched). Module initialization 3.51 to 3.38
ms (41 interleaved runs); the one-checker compile neutral (instructions
1.0004, cycles 1.0015). The intern table was already sized once for the
compile-time names.

What remains is the work itself: one shape per method definition and per
literal layout step, and the chunks' own code (25%). Removing it means not
doing it at startup: prototypes and literal layouts built at build time (a
static shape table and property maps), or the heap snapshot below.

## Later: a heap snapshot

Running the initialization at build time and mapping its heap at startup
would remove it entirely. The heap's fixed-address cage makes it more
feasible than in a moving design, but pointers outside the cage (code, data,
the runtime's tables) and the collector's metadata make it a project of its
own.

## Gates

- Rust tests of the splitter: labels and gotos, `else`, nested blocks,
  shadowing, depth-0 statics and arrays, shared and chunk-local variables,
  the fallbacks.
- Conformance through units with the split forced on every program
  (`TSAOT_CONF_UNITS=1`, a low cold threshold and chunk size).
- tsc-ts: outputs identical at 1, 4 and 10 checkers; the startup and compile
  A/B; the build time.
