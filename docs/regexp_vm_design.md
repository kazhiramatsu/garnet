# The regexp engine, rewritten as a bytecode VM (design, Session 357)

Kaz's direction (2026-10-28): 「正規表現はVM型にしてフルスクラッチで書き直してください。v8と同レベルまでの
速度を出したいです。ただし大きめの作業なので別スライスで。」 The regular expression engine is rewritten
from scratch as a bytecode virtual machine, its speed to match V8 (Irregexp), as its own series of
slices. This document is the design: what is replaced, the semantics the engine must have, the
architecture, the slices and their gates.

## What is replaced

Today a RegExp is a plain object (`TS_KIND_OBJECT`, prototype `RegExp.prototype`) carrying `source`,
`flags`, `lastIndex` and the hidden `__tsaot_rx_flags_mask` / `__tsaot_rx_prefix` / `_global` /
`_sticky` / `_anchor` properties; the engine is QuickJS's `libregexp` (a backtracking bytecode
interpreter) behind `runtime/regexp/ts_regexp_adapter.c`, which converts the pattern to CESU-8 /
UTF-8 bytes, keeps an immortal content-keyed cache of compiled programs, copies UTF-16 input into a
temporary buffer per exec, reads the object's hidden properties through `ts_get_ic` on every call
(vue's compiler phase: 1.29 M `__tsaot_rx_prefix` lookups per run), and mallocs the capture array
per exec. The exporter classifies literals (`exporter/regexp.ts`) into a literal-prefix fast path
(`ts_regexp_litprefix_*` in ts_rt.c), a first-character prefilter lives in the adapter, and every
other pattern runs libregexp's own position loop. hono's RegExpRouter was left out of the benchmark
for the engine's speed (`docs/real_projects.md`).

Everything under `runtime/regexp/` is replaced: the parser, the compiler, the matcher, the Unicode
tables and the adapter. `runtime/unicode/` (String `normalize` / case mapping over QuickJS's
`libunicode`) is not part of this work and keeps its vendored source; the vendoring script loses
`libregexp`.

## Semantics (the contract: V8 14.1, Node 25, Unicode 17)

The oracle is Node (V8 14.1.146, ICU 78, Unicode 17.0). The engine implements ECMAScript 2025
RegExp with every flag `d g i m s u v y`, including:

- Syntax: disjunction, alternatives, assertions `^ $ \b \B`, lookahead `(?= )` `(?! )`,
  lookbehind `(?<= )` `(?<! )`, groups `( )` `(?: )` `(?<name> )`, modifiers `(?ims-ims: )`,
  quantifiers `* + ? {n} {n,} {n,m}` and their lazy forms, `.`, character classes with ranges,
  class escapes `\d \D \s \S \w \W`, escapes `\t \n \v \f \r \cX \xhh \uhhhh \u{...} \0`,
  identity escapes, backreferences `\1..\99` and `\k<name>` (duplicate names in different
  alternatives), `\p{...}` / `\P{...}` (General_Category, Script, Script_Extensions, the binary
  properties ECMA-262 lists) in `u`/`v` mode, and the `v`-mode class set syntax (nested classes,
  `--`, `&&`, `\q{a|bc}`, the properties of strings `RGI_Emoji` etc.).
- Annex B (non-`u` mode only): octal escapes and `\8 \9`, invalid escapes as identity escapes,
  `]`, `{` and `}` as pattern characters, incomplete `{` quantifiers as literals, `\c` without a
  letter, `[\c_]`, quantified lookaheads, `\k` as an identity escape when the pattern has no named
  group.
- Matching: the spec's backtracking order (leftmost alternative first, greedy before lazy),
  captures reset on every iteration of a quantified group (RepeatMatcher step 4), an iteration
  that matches empty fails once the minimum is met (step 2.b), lookarounds are atomic, lookbehind
  matches backward (captures inside it are set end-first), backreferences to unset groups match
  empty, case-insensitive matching through `Canonicalize` (non-`u`: the simple uppercase mapping
  with the no-ASCII-from-non-ASCII rule, so `/ſ/i` does not match `s`; `u`/`v`: simple case
  folding, so it does, and `K` matches `[a-z]`), `.`/`^`/`$`/`\b` with `s`/`m`, code points in
  `u`/`v` mode (surrogate pairs as one character, lone surrogates as themselves,
  `AdvanceStringIndex` after an empty match), `lastIndex` read as ToLength and written back for
  `g`/`y` (0 on failure), sticky anchoring.
- The API surface the exporter lowers today, unchanged in shape: literal and constructed RegExps
  (`regexp.construct` for a dynamic pattern or flags, `SyntaxError` with V8's messages), `test`,
  `exec` (the result array with `index`, `input`, `groups` (null-prototype), `indices` under `d`),
  `String.prototype.match / matchAll / replace / replaceAll / search / split` with a RegExp,
  replacement patterns (`$$ $& $\` $' $n $nn $<name>`) and function replacers (receiving the
  captures, the position, the input and `groups`), `source` / `flags` / `toString`,
  `Object.prototype.toString`, `instanceof RegExp`. New: `RegExp.escape`, and a RegExp argument
  to the dynamic string methods (`(s as any).replace(re, f)`), which the runtime treated as a
  string.
- Limits: a backtrack stack of 64 MiB; past it the match throws `RangeError: Maximum call stack
  size exceeded` (V8's message). Out of the model, rejected loudly as today: the `Symbol.replace`
  / `Symbol.split` / `Symbol.match` protocol on RegExp subclasses, `RegExp.prototype.compile`,
  the legacy static properties (`RegExp.$1`), the `l` flag.

## Architecture

```
pattern (UTF-16 code units) + flags
   |  rx_parse.c   two passes: group/name scan, then the grammar -> AST (arena)
   v
AST --- rx_compile.c: analysis (capture count, min length, anchoring, the first-character set,
   |                   the literal prefix, simple-loop and fixed-width facts) -> bytecode
   v
rx_program (bytecode, class sets, prefilter tables, group names; refcounted, cached by (source, flags))
   |
   |  rx_vm.c: the search loop (prefilters) and the matcher, instantiated for Latin-1 and UTF-16
   v
captures (int32 pairs) -> ts_regexp_adapter.c builds the JS results
```

### Files (all new, `runtime/regexp/`)

- `rx.h` — the engine's C API over plain buffers, no `tsv`: `rx_compile(const uint16_t* src,
  uint32_t len, uint32_t flags, rx_error* err)`, `rx_exec(prog, input, len, wide, start, caps,
  scratch)`, `rx_program_retain/release`, the program's `ngroups`, group names, flags, and
  `rx_emit_c` for the native tier (slice R3). Unit-testable without the runtime (`rx_test.c`).
- `rx_parse.c` — the parser. Input is the pattern as UTF-16 code units (a Latin-1 pattern read
  through an accessor); output an arena-allocated AST: `Disjunction`, `Alternative`, `Assertion`,
  `Look{ahead,behind,negate}`, `Group{index,name,modifiers}`, `Quantifier{min,max,greedy,
  first_group,last_group}`, `Char` (code point), `Class` (a code point set and, in `v` mode, a
  string list), `Dot`, `BackRef` (an index list for duplicate names), `Empty`. Pass 1 counts the
  capturing groups and collects names (forward references, and Annex B's `\k` rule depend on it);
  pass 2 parses. Errors carry V8's reason strings ("Unterminated group", "Nothing to repeat",
  "Invalid escape", "Lone quantifier brackets", "Range out of order in character class",
  "Invalid property name", "Duplicate capture group name", ...), formatted as
  `Invalid regular expression: /src/flags: reason`.
- `rx_compile.c` — AST to bytecode, with the analysis the search loop and the fast ops need.
- `rx_vm.c` — the matcher: a register file (2 per group, loop counters, empty-check and
  lookaround registers), an explicit backtrack stack of tagged 32-bit words, computed-goto
  dispatch (`switch` fallback), the interpreter body included twice (`RX_WIDE` 0/1) so the
  Latin-1 path never tests for surrogates and the UTF-16 path decodes pairs only in `u`/`v`
  mode.
- `rx_unicode.c` + `rx_unicode_tables.h` — generated by `scripts/gen_rx_unicode.py` from the
  Unicode 17.0.0 Character Database (downloaded by the script into `build/ucd/17.0.0/`; the
  generated header is committed): the non-`u` canonicalization table, simple case folding,
  the `\w`-with-`iu` extras, ID_Start / ID_Continue (group names), General_Category, Script and
  Script_Extensions range tables, the binary properties, and (R3) the emoji sequence sets. Two-
  level tables for the BMP (one byte per code point for canonicalization, bit sets for the
  properties), sorted ranges with binary search above it.
- `ts_regexp_adapter.c` — rewritten on `rx.h`: the RegExp object, the compile cache, the exec
  results, `match / matchAll / replace / split / search`, the quick entry points of literal call
  sites, `RegExp.escape`. The entry-point names and signatures the emitter calls
  (`ts_regexp_adapter_*_tsv`, `ts_regexp_object_init`, `ts_regexp_is_object`, ...) are kept where
  the generated C is unchanged by the slice, so the exporter and the emitter change only where
  the object model does.

### The RegExp object

A new heap kind, `TS_KIND_REGEXP`:

```c
typedef struct ts_regexp {
  ts_obj_common o;     /* prototype RegExp.prototype; the named-property map holds lastIndex at slot 0 */
  rx_program* prog;    /* a reference on the compiled program (released by the sweep) */
  tsv source;          /* the source string, EscapeRegExpPattern applied */
  uint32_t flags;      /* RX_F_* */
} ts_regexp;
```

`lastIndex` is an own data property (writable, non-enumerable, non-configurable) in the object's
property map, defined at construction, so every generic path (`re.lastIndex = 0`, a descriptor
read, enumeration, `JSON.stringify` giving `{}`, a Proxy over the object) works unchanged; the
engine reads and writes it through the map's first slot when the object's shape is the regexp
shape (one compare, V8's fast-regexp map check) and through the generic path otherwise. `source`
and `flags` are read by the adapter from the struct (today's own `source`/`flags` data properties
go away: V8 keeps them as prototype accessors, and `Object.getOwnPropertyNames(/a/)` is
`["lastIndex"]`). `typeof` gives `object`, `Object.prototype.toString` `[object RegExp]`,
`instanceof RegExp` tests the kind, the collector traces `source` and the map and releases
`prog` on sweep; `ts_is_propbag` / `ts_object_like` admit the kind like a Map. `g_has_regexps`
gates the kind tests on the dynamic string methods.

Programs: `rx_program` is refcounted. The compile cache (`(source bytes, flags)` -> program; a
bounded LRU of 1024 entries for dynamic patterns) and the identity cache of static literal
sources (`g_regexp_id_cache`, per pattern cell) stay; a regexp literal's program is compiled on
the first evaluation of the literal and shared by every object the literal creates. Each
generated call site keeps a static program cell in R2 (`ts_regexp_quick_test(&cell, ...)`), so
`/x/.test(s)` costs no lookup at all.

### The bytecode

Registers: `cap[2*ngroups]` (−1 = unset), counters, saved positions. Backtrack stack entries
(uint32 words): `BT_RESUME pc pos` (continue at pc with pos), `BT_RESTORE reg value` (restore a
register while unwinding), `BT_GREEDY pc pos_min pos count` (a simple greedy loop's single entry),
`BT_MARK` (a lookaround's boundary). FAIL pops entries: a RESTORE is applied and popping goes
on, a RESUME resumes, an empty stack fails the attempt.

Ops (an immediate's width is fixed per op):

- Text: `CHAR c`, `CHAR2 c1 c2` (a case pair), `CHARS n c..` (a literal run, memcmp on Latin-1),
  `CHAR_I canon` (compare `Canonicalize(input)`), `ANY`, `ANY_NL` (dotAll), `CLASS id`,
  `NCLASS id`, their `_CP` forms in `u`/`v` mode (a surrogate pair is one character), their `_BW`
  forms for lookbehind (read `input[pos-1]`, move left), `STRINGS id` (a `v`-mode class with
  strings: longest first, then the code point set).
- Assertions: `BOL`, `EOL`, `BOL_M`, `EOL_M`, `WORDB`, `NWORDB` (an `iu` variant includes
  U+017F and U+212A).
- Control: `JMP`, `PUSH_BT label` (a choice point), `SAVE reg` (pos into a capture register,
  with a RESTORE pushed), `CLEAR first last` (the captures of a quantified group at each
  iteration), `COUNTER_INIT reg`, `COUNTER_INC_JL reg n label`, `EMPTY_START reg`,
  `EMPTY_CHECK reg` (fail the iteration when pos equals the saved position), `LOOK kind body_pc`
  (a lookaround runs the body as a sub-match with its own stack region; positive keeps the
  captures, negative restores them), `BACKREF n` with `_I` and `_BW` forms, `BACKREF_LIST`
  (duplicate names), `ACCEPT`, `FAIL`.
- Loops: `GREEDY_CLASS id min max` / `GREEDY_CHAR c min max` and the `LAZY_` forms: a single-
  character body without captures runs as a tight scan and keeps one backtrack entry that steps
  one character per backtrack (V8's greedy-loop optimization: `[^a-z0-9]+`, `\s*`, `.*` are these).
  A loop body of fixed width without captures gets the same single-entry treatment. Other
  quantifiers unroll up to 3 mandatory iterations and use counters above that.

Classes: a `CLASS` is a 256-bit bitmap for code units below 256 (one load, one bit test), a
sorted range table above it (binary search), and under `i` the set of canonical values (the
spec's CharacterSetMatcher with Canonicalize on both sides: the input is canonicalized through the
table and tested against the canonicalized set). `\d \s \w` and their complements are prebuilt.

### The search loop (prefilters)

`rx_exec` tries positions from `start` to `len - min_len`:

- anchored (`^` without `m` in every alternative, or sticky): one attempt at `start` (and only at
  0 for the anchor; `/^a/g` with `lastIndex` 3 fails without a scan);
- a literal prefix of 2+ characters: `memmem`-style search (the runtime's two-way finder over
  views) for the candidate positions, case-sensitive patterns only;
- a first-character set that excludes most input: the Latin-1 bitmap scan (a byte table) or the
  UTF-16 scan with the "wide" bit; declined, as the current prefilter is, when the set holds the
  lower-case letters (an identifier-heavy input makes every position a candidate);
- otherwise every position, with the min-length bound.

Inside the attempt the fast ops do the rest. The expected gain over libregexp on the measured
patterns (the tsc path patterns, vue's `isSimpleIdentifier`, the router tables) comes from the
greedy loops and the prefilters running as C loops instead of per-character bytecode.

### The native tier (R3)

garnet compiles ahead of time, so a regexp literal can be compiled to C at build time: V8's
native Irregexp tier, without a JIT. The design, so that the engine stays one implementation:

- **What is generated.** `rx_emit_c(program, id)` (in `rx_emit.c`, over the bytecode and the
  analysis) writes two C functions, `rx_native_<id>_8` and `rx_native_<id>_16` (Latin-1 and
  UTF-16 input), each with the interpreter run's contract: `int fn(rx_ctx* c, uint32_t pos,
  uint32_t base, uint32_t* out_pos)`, 1 on ACCEPT, 0 when the backtrack stack unwinds to `base`,
  RX_EXEC_OVERFLOW past the limit. The search loop (`rx_exec`: the prefilters, sticky and
  anchored starts, the unit-wise scan) stays in the engine and calls the native function instead
  of `rx_run_*` when the program carries one (`prog->native[wide]`), so every search-side fact
  lives in one place and a native function is small.
- **Code shape.** A goto-based state machine: each text op becomes straight-line C (`if (pos >=
  len || in[pos] != 'a') goto fail; pos++;`), a class a bitmap test against a `static const`
  table emitted with the function (the ranges above 256 likewise), a simple loop a tight C loop
  with the GREEDY/LAZY backtrack entry, a choice point a push of a *label id*; the `fail` block
  pops entries and resumes through a `switch` over the label ids (the backtrack trampoline), the
  GREEDY and LAZY entries resuming into per-loop cases that step back or forward. Registers
  (captures, counters, empty checks) are a local `int32_t regs[n]` as in the interpreter; the
  backtrack stack is the context's. Lookaround bodies are emitted as nested static functions
  with the same contract and called as the LOOK op calls the sub-run (a positive lookahead
  keeps only the RESTORE entries, a negative one unwinds them); backreferences and the case
  tables go through helpers exported in `rx_native.h` (the context, the push and set helpers as
  static inlines, the canonicalization tables).
- **Where it runs.** The analyzer links the engine (`analyzer/build.rs` compiles
  `runtime/regexp/rx_engine.c` with the `cc` crate) and calls `rx_emit_c` through FFI for each
  regexp literal with a constant source and valid flags; the emitted C goes into the program's
  unit beside the site, and the site binds it: `ts_regexp_new_literal_native(source, flags,
  rx_native_<id>_8, rx_native_<id>_16)` sets the program's `native[]` when the program is first
  compiled through the cache (the program of a literal is shared by every object the literal
  creates, so one binding serves them all); the literal call sites (`regexp.quickTest` and the
  others) take the same functions. A pattern that cannot be emitted (none is expected: the
  emitter covers the whole opcode set, with the `v`-mode strings expanded as the interpreter
  sees them) leaves the program on the interpreter. `TSAOT_REGEXP_NATIVE=0` (an exporter knob)
  emits no native functions, for the A/B.
- **Expected gain.** The dispatch and operand decoding vanish and clang optimizes across the
  pattern: the per-character cost of the validate / search kernels (the interpreter is 40-50% of
  their time) should fall by 2-3x, which is what separates them from Node; the tokenizer-style
  sticky tests keep their per-call costs (the adapter's exec, the lastIndex slot), which R2
  trimmed.

## Verification

- Conformance (the oracle is Node): the 23 regexp fixtures and the 29 others that use RegExps,
  plus a generated differential corpus, `scripts/gen_regexp_corpus.py` writing
  `tests/conformance/exhaustive/regexp/vm_*.ts` (committed): tables of `[pattern, flags, inputs]`
  printing a canonical rendering of `exec` over `lastIndex` iteration, `test`, `search`,
  `match`, `matchAll`, `replace` with pattern and function replacers, `split` with limits, the
  `indices`, the error message of every invalid pattern. Categories: escapes and literals,
  classes, every quantifier form and nesting (the empty-iteration rule, capture resets),
  alternation order, backreferences (forward, unset, case-insensitive, in lookbehind),
  lookarounds (nested, with captures), anchors and `\b` under `m`/`s`/`iu`, case-insensitivity
  (ASCII, Latin-1, Greek sigma, Turkish dotted I, `ſ`, `K`, `ß`), `u`-mode code points and lone
  surrogates, `\p{}` properties (every General_Category, scripts, the binary properties, negated,
  inside classes), named groups (duplicates, `groups`, `$<name>`), `d` indices, `g`/`y`/`lastIndex`
  edge cases (beyond the length, non-numeric through `any`, empty matches), the `v` syntax and set
  operations, Annex B forms, every syntax error, `RegExp.escape`, `source`/`flags`/`toString`
  escaping, replacement-pattern edge cases, split with captures and empty matches. A seeded
  grammar-driven generator adds ~3,000 random `(pattern, input)` pairs over a small alphabet to
  cross-check the backtracking order. Under GC stress as well (the adapter allocates result
  objects while holding views).
- Runtime unit tests: `rx_test.c` (the parser's AST and errors, the analysis facts, the VM on
  buffers, the backtrack-stack limit), run by `scripts/run_runtime_tests.sh`.
- The existing gates: `tests/regexp_aot_gate.sh` (a program without RegExps links no engine),
  `tests/regexp_link_gate.sh` (the marker-driven link), `tests/regexp_classifier.sh` while the
  classifier exists.
- Performance (against Node, alternating runs): `benchmarks/patterns/path_regexps.ts` (238 ms
  against Node's 112 before this work), the `string_*_pattern_*` kernels, new kernels
  `benchmarks/patterns/regexp_*.ts` (a sticky-regexp tokenizer, URL/email validation with
  alternations, log lines with named groups, a global replace with a function replacer, unicode
  property classes, a case-insensitive search, a backtracking-heavy alternation), hono's
  RegExpRouter back in `benchmarks/real/hono`, vue's compiler phase, and the tsc-ts instruction
  A/B (the scanner's and the path utilities' patterns). The target is parity with Node on each
  kernel; the native tier closes what the interpreter leaves.

## Slices

- **R1 — the engine and the object model.** `rx_parse.c`, `rx_compile.c`, `rx_vm.c`,
  `rx_unicode.c` with the generated tables, `rx_test.c`; the adapter rewritten on them; the
  `TS_KIND_REGEXP` object with `lastIndex` in the map; the exporter's literal lowering reduced to
  one builtin (`regexp.newLiteral(source, flags)`), the hidden `__tsaot_rx_*` properties and the
  `ts_regexp_litprefix_*` paths removed; the dynamic string methods accept a RegExp; libregexp
  deleted from the vendoring. Gate: all conformance (the corpus included) in three modes, unit,
  bundler, bench, GC stress, the regexp gates; no kernel slower than before.
- **R2 — speed.** The per-site program cells, the greedy loops and prefilters measured
  pattern by pattern, result objects from fixed layouts, the replace/split builders without
  intermediate strings, the `lastIndex` fast slot; the new kernels and hono's RegExpRouter
  against Node; vue and tsc-ts A/B.
- **R3 — the native tier and the long tail.** `rx_emit_c` through the Rust emitter, the
  `v`-mode string properties (the emoji sequence data), `RegExp.escape` if not in R1, the
  remaining divergences the corpus finds.

Each slice: the fixtures above, the A/Bs, the gates, a `docs/TODO.md` entry; the knob
`TSAOT_REGEXP_NATIVE=0` (R3) and `TSAOT_REGEXP_PREFILTER=0` (R2) keep the measurement variants.

## Status

- **R1 built (Session 357).** `runtime/regexp/rx_parse.c`, `rx_compile.c`, `rx_vm.c` (+ `rx_vm_body.h`,
  the interpreter body instantiated per input width), `rx_set.c`, `rx_unicode.c` with
  `rx_unicode_tables.h` generated by `scripts/gen_rx_unicode.py` from Unicode 17.0.0 (the UCD
  files are fetched into `build/ucd/17.0.0/`), `rx_engine.c` (the amalgamation the link step
  compiles), `rx_cli.c` (the test driver of `tests/regexp/rx_diff.mjs`, which feeds the engine
  (pattern, flags, input, start) cases and compares the capture indices with V8's: 41,714
  hand-written cases plus the seeded random walk, 5 differ, all V8's `\q{}`-with-`i` quirk
  below). The adapter is rewritten on `rx.h`; a RegExp is `TS_KIND_REGEXP` (`ts_regexp` in
  ts_rt.h: the program, the source, the flags; `lastIndex` in its property map; `source`,
  `flags`, `global`, ... are accessors on RegExp.prototype as in V8); the exporter lowers a
  literal to one `regexp.newLiteral` call and `RegExp.escape(s)` to `regexp.escape`, the dynamic
  String methods (`match`, `matchAll`, `search`, `replace`, `split` on an `any` receiver) accept a
  RegExp through the hooks the adapter installs (`ts_regexp_hooks`), libregexp is gone from the
  vendoring (libunicode stays for `runtime/unicode`), the literal-prefix fast paths and the
  classifier (`exporter/regexp.ts`) are deleted: the engine's own prefix and first-character
  prefilters replace them. The corpus `scripts/gen_regexp_corpus.py` writes nine fixtures
  (`tests/conformance/exhaustive/regexp/vm_*.ts`, 2,819 cases), all identical to Node.
- V8 behaviours the engine mirrors on purpose: the position loop advances one code unit at a
  time in `u` mode too (a zero-width `\B` matches between the halves of a surrogate pair and
  `"a\ud83d\ude00b".split(/\B/u)` splits the pair), a character read never starts at a pair's
  trail or ends at its lead, an initial `lastIndex` inside a pair backs up to the lead; `split`
  runs a search from the last split point (the specification's sticky walk only for a sticky
  regexp); `\p{...}` names are the ECMA-262 lists (so `IDS_Unary_Operator` and the Unicode 17
  script `Chisoi` are rejected as V8 rejects them).
- V8 deviation kept out of the fixtures: a `v`-mode class containing `\q{...}` under `i`
  (V8 does not canonicalize the input for its single-character part: `/[\q{A}]/vi` fails on
  "A"); the engine follows the specification (the folded set, the input canonicalized).
- R1's numbers: `path_regexps` 162 ms against Node's 113 (the old engine 238), vue -1.5%, tsc-ts
  unchanged; the first-character prefilter admits a selective set or one without the lower-case
  letters (tsc's negated path class), as the old adapter's prefilter did.
- **R2a built (Session 357).** The per-call costs: `lastIndex` through the cell's map slot
  (`ts_regexp_last_index_slot`, answered by `ts_get_pic_other` / `ts_set_pic` at the generated
  sites), a root-free exec for a string input with a numeric `lastIndex`, no `string.coerce`
  before the regexp calls, tight Latin-1 scans for the simple loops, `match1` inline, CHARS runs,
  SAVE_NR for the match bounds, the first-character byte table, one thread-local fetch per exec,
  the results from a per-program layout with interned group keys (`rx_set_user`), each capture
  sliced once, `split` on the regexp's own program, the matchAll iterator on a shared prototype.
  Kernels (native / Node ms): tokenizer 160 / 121, validate 124 / 89, logs 138 / 118, search
  148 / 114, path_regexps 134 / 115; vue -1.2%, tsc-ts unchanged.
- Not yet (R3): the `v`-mode properties of strings (`\p{RGI_Emoji}` and the other six; the emoji
  sequence data is in `build/ucd/17.0.0/emoji-seq/`, emoji 16.0 at the time of writing), the
  native tier (`rx_emit_c`), the per-site program cells and the fixed result layouts (R2).

