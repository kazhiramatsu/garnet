# Conservative roots: generated code without GC frames

Session 352. The corrected profile of tsc-ts
(`docs/single_thread_vs_scriptc.md`, "The profile, corrected") puts a
third of the generated code's time in the shape of a call: the frame
struct's slots written before calls, read after them and passed as
arguments, the frame linked into `g_ts_frame_top` and unlinked, the slots
filled with undefined at entry, and the C compiler's own saves of the
register pairs those homes force live. Two ceilings bound the gain: with
the collector off, the slots turned into plain locals in every function
without a try save 4.0% of the instructions, and the loads and stores of
`g_ts_frame_top` around every call are another 3-4% of the generated
code's samples (`prof_pc.py`: the hottest "other" loads are
`frame_top`'s). scriptc's generated code has no frames: its collector
is reference counting. garnet's collector does not move cells
(`docs/gc_v2_design.md` §6.8, Y2-D), which admits the other frame-free
design: the collector finds the roots in the native stack itself.

## The design

- **Roots by scanning the stack.** A collection (minor or full) spills the
  callee-saved registers (`setjmp` into a local buffer) and scans every
  8-byte word from its own frame to the main thread's stack base
  (`pthread_get_stackaddr_np`). A word is a root candidate when its low
  48 bits fall in the cage: a tagged heap reference (`ts_heap_ref`), a
  raw pointer the generated code untagged (`ts_ptr`), or a derived pointer
  into a cell (a field address the compiler formed). A stack-tagged value
  (`TS_PTR_STACK_TAG`, an escape-analysis cell on the C stack) takes the
  existing `gc_mark_visit` path; the cell's own fields are on the stack
  and are scanned as words too.
- **Validation by an allocation bitmap.** A candidate must name an
  allocated cell: nothing in a free run, nothing dead. The mark bitmap
  cannot tell a live young cell from a dead one whose header is still
  intact (its payloads were released when it died; marking it again would
  walk freed buffers), so each cell block gets a second bitmap of
  allocated cell starts: the allocator sets the bit (one `orr` per
  allocation), a death clears it, a promotion leaves it. The candidate's
  block (`(addr - cage) >> 16`) must be a cell block, the cell start is
  `addr` rounded down to the block's class size, and its allocated bit
  must be set; a large cell is its block's base. Then the cell is marked
  as a root (young: only young cells need marking; full: every cell).
- **Soundness argument.** Nothing moves, so a conservative root only
  retains; a false candidate (a number whose bits look like an address)
  keeps a dead cell alive until the next collection and nothing else. The
  collector runs only inside runtime calls made by the generated code,
  where every live value of the generated code is either in a
  callee-saved register (spilled by `setjmp` before the scan) or on the
  stack (the ABI gives the caller-saved registers to the callee). A value
  the C compiler keeps only in a NEON register across a call is in d8-d15,
  which `setjmp` saves. The runtime's own `ts_gc_root` stack and the
  frame chain keep working: a precise root marked twice is marked once.
  Tests that assert a death (the GC debugging modes) run in the precise
  mode, where no stale stack word can retain.
- **The emitter.** A third rooting mode beside frames and the legacy
  `ts_gc_root` per local (`TSAOT_FRAME_ROOTS=0`): `TSAOT_CONSERVATIVE_ROOTS=1`
  emits no frame struct, no push and pop, no spills and reloads, no slot
  arguments and no undefined fill; the lazy slow paths call the plain
  runtime functions. A function with a `try` keeps memory homes for the
  locals live across the `setjmp` (the frame struct as plain memory, never
  linked), since a `longjmp` leaves register locals indeterminate. The
  emitted `main` sets `g_conservative_roots = 1`, which turns the stack
  scan on in the collector; a program built in the precise modes never
  scans. The parity oracle sets the knob off (`scripts/emitc_diff.sh`).
- **The runtime's own rooting.** `ts_gc_root(&x)` in the runtime (4.9 M
  pushes a compile) becomes redundant under the scan; it stays for now and
  can be retired function by function later.
- **Sanitizers.** The GC stress gate builds with ASan; its fake stacks
  (`detect_stack_use_after_return`) would move locals off the native
  stack, so the gate runs with that option off, and the scan reads the
  stack through `__asan_unpoison`-free plain loads (the words are the
  thread's own stack).

## What it costs

A scan reads the live stack depth at each collection: the checker's
recursion is some hundreds of frames, tens of kilobytes, a few
microseconds per collection; the allocation bit is one `orr` per cell.

## Slices

- **C1 — the runtime.** The allocated bitmap; `gc_scan_stack_roots(young)`
  called by both collectors when `g_conservative_roots`; a runtime unit
  test that allocates with references held only in locals, forces
  collections at every allocation and checks the cells survive; the GC
  stress gate on the existing fixtures (the precise emitter, the scan on
  through an env knob, to prove the scan never frees a live cell).
- **C2 — the emitter.** The mode; the try functions' memory homes; the
  kernels and tsc-ts measured (instructions, cycles, wall); parity with
  the knob off; conformance plain and strict, protect mode, GC stress with
  the new mode on.
- **C3 — the default.** Flip the default, update the oracle's knob list,
  the docs.

## As built (C1 and C2, Session 352)

- The allocation bitmap is a second bitmap per block beside the marks
  (`g_cage_alloc_bits`, reserved with the cage tables). `gc_cell_alloc` and
  `gc_cell_alloc_large` set the cell's bit when `g_conservative_roots`;
  `gc_cell_die` and `gc_cell_release_large` clear it. A dead young cell of a
  kind without side buffers is never visited, so after every collection the
  bits of the blocks allocated into since the previous one are intersected
  with the marks (`gc_alloc_bits_settle`): the allocator's refills put a
  block on the dirty list (kept whether or not the bits are, so that a
  program switching the roots on finds every block it allocates into
  tracked), and the blocks under the class cursors are put back on it after
  the settle, since allocation continues in them without a refill.
- `gc_scan_stack_roots(young)` runs in both collectors after the frame
  chain: `setjmp` spills the callee-saved registers into a local buffer, a
  deeper frame scans from its own local to `pthread_get_stackaddr_np` of
  the main thread, and the buffer is scanned too. A candidate word in a
  cell block is rounded down to its class's cell start and must have its
  allocation bit; a word in a large cell's run walks back to the head
  block; a stack-tagged word takes `gc_mark_visit`. The scanning functions
  are `no_sanitize("address")` (the words are the thread's own stack; ASan's
  fake stacks are off by default on this toolchain, checked).
- A stack-tagged word is not followed. The first protect-mode run (a
  collection at every allocation, freed cells quarantined) crashed three
  fixtures with stack-allocated cells and closures: a stale stack-tagged word
  in a live frame named a dead frame's cell, by then other frames' words,
  whose garbage header passed the plausibility tests, and the marker read
  through its "fields". The precise frames never hold such a word (the
  escape analysis keeps a stack cell alive past every frame that names it).
  The cells themselves lie in the scanned region, so their heap references
  are found as words, and nothing is lost by skipping the tag. All three
  fixtures then pass under protect mode with V8's output.
- A function that allocates a cell on the C stack (a closure or a class
  instance with the `Stack` strategy) keeps its frame too: the GC stress gate
  found a stack cell whose property map, a buffer off the stack, held the
  only references to heap values the word scan cannot see. In tsc-ts 350 of
  21,020 functions keep a frame for a try or a stack cell.
- `g_gc_debug_watch` (tests): the scan reports the stack word that names a
  given cell. It showed what a conservative collector always has: a stale
  word in a long-lived frame (`main`'s, in the runtime tests) names
  whatever cell its address holds now, so the death check of the runtime
  test is over 256 cells, of which at least 240 must lose their bits.
- The emitter (`TSAOT_CONSERVATIVE_ROOTS=1`): `use_frame_roots` holds only
  for a function with a try; the three entry emitters skip the legacy
  `ts_gc_root(&v)` loops and count no roots to pop; `main` sets
  `g_conservative_roots = 1`. Kernels (strict profile, G instructions,
  frames -> conservative): `class_nodes` 6.08 -> 5.40, `tree_recursion`
  2.30 -> 2.01, `small_calls` 20.59 -> 20.63 (its frames were already lazy
  and elided), `callbacks` 7.22 -> 7.23. Conformance 539/539 plain with the
  mode on; the full gates and the tsc-ts build run next.

## Result (C3: the default)

tsc-ts, one thread, the TypeScript compiler project, the frames build
against the conservative build (outputs identical, six interleaved pairs):
instructions 31.77 -> 28.55 G (0.899), cycles 7.14 -> 6.46 G (0.900), wall
1.66 -> 1.50 s (0.904), peak memory 705 -> 710 MB. The kernels (strict
profile, G instructions): `class_nodes` 6.08 -> 5.40, `closures_env` 6.29 ->
4.77, `obj_literal_poly` 5.76 -> 4.97, `tree_recursion` 2.30 -> 2.01,
`string_scan` 7.33 -> 6.89, `object_arrays` 5.83 -> 5.43, `callbacks` 7.41
-> 7.22, `switch_dispatch` 9.14 -> 8.95, `flags_truthy` 8.91 -> 8.50;
`small_calls`, `map_string_keys`, `string_keys`, `path_regexps` unchanged.
Gates with the mode on: parity (the oracle sets the knob off), unit,
bundler 43/43, conformance 539/539 plain and strict, 536/536 under protect
mode, GC stress (O2 and ASan), the runtime tests with the new conservative
cases. `TSAOT_CONSERVATIVE_ROOTS=1` is the default; `=0` keeps the frames.
