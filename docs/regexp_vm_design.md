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

The alternation's dispatch (R6): an alternative whose first set is known (`first_of`: exact
below 256, a `wide` bit for anything above; a back reference makes it unknown) and cannot be
empty is preceded by `ALT_FIRST set target flags` instead of `PUSH_BT target`. The next unit not
in the set, or the end of the input, skips to the next alternative without a choice point; a
unit in the set pushes the choice point and enters the body, unless every alternative of the
alternation has a known non-empty first set and the sets are pairwise disjoint below 256
(`RX_ALT_DISJOINT`): then no other alternative can match here and nothing is pushed. A unit of
256 or more (UTF-16 input) enters with a choice point when the set is wide and skips when it is
not. The last alternative is entered directly, and a lookbehind body (matched backward) keeps
the plain choice points. hono's route regexp is one alternation of a few disjoint branches: a
request's match pushes nothing for the routes it cannot take; an ipv4 octet's alternatives
overlap on their first digit and keep their choice points. The native tier emits the same test
(`rx_emit.c`), the guard's set as a bitmap-only table.

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

garnet compiles ahead of time, so a regexp literal is compiled to C at build time: V8's native
Irregexp tier, without a JIT. The design keeps the engine one implementation:

- **What is generated.** `rx_emit_c(program, id)` (`rx_emit.c`, over the bytecode and the
  analysis) writes two C functions, `rx_native_<id>_8` and `rx_native_<id>_16` (Latin-1 and
  UTF-16 input), each with the interpreter run's contract (`rx_native.h`): `int fn(rx_ctx* c,
  uint32_t pos, uint32_t base, uint32_t* out_pos)`, 1 on ACCEPT, 0 when the backtrack stack
  unwinds to `base`, RX_EXEC_OVERFLOW past the limit. The search loop (`rx_exec`: the
  prefilters, sticky and anchored starts, the unit-wise scan) stays in the engine and calls the
  native function instead of `rx_run_*` when the program carries one (`prog->native[wide]`, one
  predictable branch per attempt), so every search-side fact lives in one place and a native
  function is small.
- **Code shape.** A goto-based state machine over the same registers and backtrack stack as the
  interpreter (`rx_ctx`: the context, the push, compact and unwind helpers and the character
  tests are static inlines in `rx_native.h`): each text op is straight-line C (`if (pos >= len)
  goto fail; ch = in[pos++]; if (!(ch == 97u)) goto fail;`), a class a test against a `static
  const` table emitted with the functions (the bitmap below 256 and the ranges above), a
  character run one comparison chain, a simple loop the interpreter's tight scan (Latin-1,
  forward) or a `for` over the one-character test, with the GREEDY/LAZY entry; a choice point
  pushes its target pc and the `fail` block pops entries and resumes through a `switch` over the
  pcs (the backtrack trampoline), the GREEDY and LAZY entries resuming into per-loop cases that
  step back (`rx_unstep_*`) or forward. Lookaround bodies are nested static functions with the
  same contract (`<name>_lk<pc>`), called as the LOOK op calls the sub-run: a positive one keeps
  only the RESTORE entries (`rx_bt_compact`), a negative one unwinds them (`rx_bt_unwind`).
  Backreferences go through `rx_backref_cmp_*` exported by the engine, the case tables through
  `rx_g_canon_bmp` / `rx_g_fold_bmp`.
- **Where it runs.** The analyzer links the engine (`analyzer/build.rs` compiles
  `runtime/regexp/rx_engine.c` and `rx_emit.c` with the `cc` crate) and `rx_native.rs` calls
  `rx_emit_native` through FFI once per distinct (source, flags) of the program's regexp literal
  sites: `regexp.newLiteral` and the `regexp.quick*` calls whose pattern and flags are constants
  (`rx_native_sites_for`). The emitted C is one block after the includes; the site passes its
  matchers to the adapter, `ts_regexp_new_literal(source, flags, rx_native_<id>_8,
  rx_native_<id>_16)` and the quick entry points alike (`NULL, NULL` from the function-value
  paths and the runtime's own calls), and `compile_pattern` binds them to the program on its first
  use (`rx_set_native`: the first binding sticks, as the program is shared by every site of the
  pattern through the identity and content caches). In the unit build the matchers and their
  tables land in the data unit (no module of their own) and the sites reference them across
  units. A pattern that does not compile (a `new RegExp("(")` with constant arguments) gets no
  matchers: the runtime throws the SyntaxError as before. `TSAOT_REGEXP_NATIVE=0` at the
  analyzer emits no matchers; the same variable at run time makes the adapter ignore the ones
  it is passed (the A/B on one binary).
- **Verification.** `tests/regexp/rx_diff.mjs --native`: `rx_cli -E` writes the matchers of
  every distinct pattern of the corpus (43,593 cases) with a table, the driver is built again over
  that C (`-DRX_NATIVE_TABLE`) and binds each program before the run, and the results are
  compared with V8's as in the interpreter mode; the conformance fixtures run every literal
  through the native tier.

### The per-call path (R4)

After the native tier the matchers are a minority of a regexp-heavy kernel's time (R3's
profiles: 20% of the tokenizer, a third of the validate kernel); the rest is what happens
around each call. R4 trims that path without changing what a call means:

- **A typed `lastIndex`.** The exporter lowers `re.lastIndex` reads and `re.lastIndex = v`
  writes (the compound and update forms through `lowerAssignTarget`) on a receiver typed RegExp
  to `regexp.getLastIndex` / `regexp.setLastIndex`; the runtime's `ts_regexp_last_index_read` /
  `_write` take the map's first slot when the value is a RegExp whose `lastIndex` is a plain
  writable data property, and otherwise run the untyped site's generic paths with a static inline
  cache (`ts_get_pic_checked` / `ts_set_pic`: a plain object or null behind the annotation, a
  read-only `lastIndex`, a frozen RegExp keep their errors and semantics). The generic
  `ts_set_pic` preamble that the generated store paid before (the kind and cache checks ahead of
  the RegExp case) is gone from a tokenizer's inner loop.
- **The result arrays.** `exec`'s array (and `indices`) is allocated at its length and filled by
  index, and its named properties (`index`, `input`, `groups`, `indices`) are stored through
  inline caches held by the adapter: every result starts from the empty array shape and adds the
  same keys in the same order, so the addition cache answers each store without the probe of the
  receiver and its prototype chain that a generic set does (the `lookup_prop_chain` / `prop_find`
  share of the search kernel's profile).
- **An empty operand of `+`.** `s + ""` and `"" + s` return the other string itself (as V8 does)
  instead of copying it: the validate kernel's `samples[i] + ""` spent a seventh of its time in
  the copy.
- **The quick check.** V8's Irregexp tests the first few characters of a candidate position
  against a mask and value before entering the matcher; the compiler now derives the same
  (`qc_of`): for the first positions every match has (at most four, within `min_len`) the set of
  bytes possible there, exact while every earlier part of the pattern has one possible length
  (a varying quantifier, an alternation of different lengths or a backreference ends the
  exactness; a lookaround or an anchor contributes nothing, a superset), and from each set the
  bits all its members share (`mask = ~(and ^ or)`, `value = and & mask`). The search loop tests
  `(word & mask) == value` over the little-endian word of those bytes after the prefilter and
  before `try_at`, on Latin-1 input (a UTF-16 input skips it). A position whose set is empty
  means no Latin-1 input can match (`narrow_impossible`: the exec returns no match at once).
  `/error|warning|fatal/i` gets four positions ({e,E,w,W,f,F}, {r,R,a,A}, ...), `[aeiou]{2,}`
  two; an anchored or sticky pattern has no search loop and no check.

### The native tier for run-time patterns (R9)

A pattern the program builds at run time (`new RegExp(src)`: hono's route regexps, assembled
from the route table at start-up; a tokenizer's keyword alternation joined from a list) runs on
the interpreter, since the native tier needs the pattern at build time, while V8 compiles it just
in time. garnet's answer is the one it has for hot functions (docs/pgo_design.md): a training run
records what the program did, and the build uses the record.

- **The record.** Under `TSAOT_REGEXP_RECORD=<file>` the adapter appends a line for every
  pattern it compiles without matchers from its site (the constructor, a string pattern given to
  `split` or `replace`; a literal's site passes matchers and is not recorded): `<flags>`, a tab,
  the pattern as hex UTF-16 code units (the format of `rx_cli` and the engine diff), a tab, the
  source in UTF-8 (informational; a reader ignores it). The training run of `garnet --pgo-train`
  and of `build_tsc_ts_native.sh` sets the variable (`tsaot_pgo_train`, with the raw profiles'
  directory), and the merge sorts and dedups the lines into `default.regexps` next to the entry
  file, beside `default.pgo` (written when the record has lines; an empty record removes a stale
  file and says so). A forked worker's compiles land in the same file (append).
- **The build.** `default.regexps` is looked for where `default.pgo` is (the entry file's
  directory, then the project's tsconfig directory); `--regexps <auto|off|file>`
  (`TSAOT_REGEXPS`) chooses, and `--pgo off` turns it off as well: a plain build is plain. The
  driver runs `tsaot regexps <file>`, which writes `rx_table.c`: the matchers of every distinct
  (source, flags) of the file, emitted as for a literal (`rx_emit.c`; a line that does not parse
  or compile is skipped with a note), `static` in that unit, a table of `{ units, length,
  flags, narrow, wide }` and a constructor function that installs the table in the engine
  (`rx_native_table_install`). The file is compiled with the pass's flags into one object on the
  link line next to the engine's objects. The program's own C is unchanged: no second export or
  emission, the unit cache untouched, and a changed `default.regexps` recompiles one small file.
  `TSAOT_REGEXP_NATIVE=0` at the build emits no table.
- **The binding.** `compile_units`, on a content-cache miss after `rx_compile`, looks the pattern
  up in the installed table (`rx_native_table_find`: the length and flags first, then the units)
  and binds the matchers to the program (`rx_set_native`; `TSAOT_REGEXP_NATIVE=0` at run time
  ignores the table as it ignores a literal's matchers). The lookup runs once per distinct
  pattern, since the content cache holds the program afterwards: the per-call path is untouched.
  A pattern recorded at training and built from another string at run time binds by content; a
  pattern the program no longer builds costs the object's size and nothing else; a pattern the
  training did not reach stays on the interpreter, correct as before.
- **Why a separate object.** The record exists only after the instrumented program ran, so
  emitting the table into the program's C would mean a second export and emission and a second
  round through the unit cache. The subcommand takes milliseconds and the object is small.
- **Verification.** The matchers come from the emitter the engine diff checks in its `--native`
  mode (43,593 cases). `tests/pgo_build_gate.sh` trains a program that builds a pattern from a
  string at run time: `default.regexps` holds the pattern, the trained build prints what the
  plain one prints, `TSAOT_REGEXP_TRACE=1` reports the binding, and `--regexps off` and `--pgo
  off` leave the pattern on the interpreter.
- **Benchmarks.** `benchmarks/real/run.sh` takes `TSAOT_REAL_PGO=train|auto|off`: `train` runs
  `--pgo-train` with the driver's own workload inside the clone (the files land next to
  `garnet-driver.ts` there), `auto` applies what an earlier training left, `off` is the plain
  build that the earlier sessions' numbers come from. `build_tsc_ts_native.sh`'s training records
  as well, and `build.json` names the file (`pgo.regexps`).

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
- **R3 — the native tier.** `rx_emit_c` through the Rust emitter.
- **R4 — the per-call path.** The typed `lastIndex`, the result arrays through inline caches,
  the quick check of the search loop, `s + ""`.
- **R5 — hono's RegExpRouter.** The result array and its consumers outside the matcher: lib's
  `RegExpMatchArray` / `RegExpExecArray` as array receivers in the exporter, the result array's
  named properties as an adopted layout, a key cache for immediate short strings; the regexp
  routers back in `benchmarks/real/hono/driver.ts`.
- **R6 — the RegExpRouter's second round.** The alternation's first-character dispatch
  (`ALT_FIRST`), a megamorphic answer for dynamic-key sites whose keys vary, a root-free string
  exec, a union of array types as an array receiver in the exporter.
- **R7 — the RegExpRouter's third round.** The dynamic-key read in line (the key id of a string at
  hand, a key-validating cache probe), the result array in one cell, `CHARS` compared a word at a
  time, `SAVE` without a restore entry on an empty stack, an immediate needle's `indexOf`, the
  short captures as immediates.
- **The long tail.** The `v`-mode string properties (the emoji sequence data), the remaining
  divergences the corpus finds.

Each slice: the fixtures above, the A/Bs, the gates, a `docs/TODO.md` entry; the knob
`TSAOT_REGEXP_NATIVE=0` (R3; the analyzer emits no matchers, the runtime ignores them) keeps the
measurement variant.

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
- **R3 built (Session 357): the native tier.** `rx_emit.c` writes a program's matchers as C
  (the section above), `rx_native.h` holds what they share with the interpreter (`rx_vm.c` now
  runs on it: the context, the backtrack entries, `rx_bt_grow`, `rx_unstep_*` and
  `rx_backref_cmp_*` exported), the search loop dispatches on `prog->native[wide]`; the analyzer
  links the engine (`build.rs`, the `cc` crate) and `rx_native.rs` writes the matchers of every
  literal site with constant source and flags into the program's C, the sites pass them to the
  adapter (`ts_regexp_new_literal` and the quick entry points take the pair), `compile_pattern`
  binds them on first use. The engine diff in native mode (`rx_diff.mjs --native`): 43,593 cases,
  0 differ (6.6 MB of C for the corpus, built in 8 s). Kernels, the interpreter -> the native
  tier, one binary with `TSAOT_REGEXP_NATIVE=0` for the A (Node in parentheses): tokenizer 170 ->
  149 (118), validate 127 -> 104 (87), logs 140 -> 133 (116), search 157 -> 124 (111),
  path_regexps 141 -> 126 (112). The profiles after it: the matchers are 20% of the tokenizer
  (the sticky `test` path's per-call costs are 60%: `builtin_exec`, the generated `lastIndex`
  store through `ts_set_pic`, the slot lookup, `rx_exec` and `try_at`), a third of the validate
  kernel (the adapter's per-call path another third), the backtracking alternation 22% of the
  search kernel with the search loop's byte scan 17% and the result objects 12%: the next slice
  is the per-call path (a typed `lastIndex` access, a slimmer sticky exec, the first-character
  scan), not the matchers.
- **R4 built (Session 357): the per-call path.** The typed `lastIndex` (`regexp.getLastIndex` /
  `setLastIndex`, `ts_regexp_last_index_read` / `_write`), the result arrays through the
  adapter's inline caches, `s + ""` without a copy, the quick check of the search loop (`qc_of`,
  `narrow_impossible`); fixture `regexp/last_index_typed`. Kernels R3 -> R4 (Node): tokenizer
  151 -> 141 (121), validate 104 -> 96 (87), logs 134 -> 134 (116), search 124 -> 116 (114),
  path_regexps 126 -> 128 (113, within the spread); vue and tsc-ts unchanged. What remains
  (the profiles): the call structure of a sticky `test` (three calls from the site to the
  matcher, the `lastIndex` write as a call), a choice point per alternative in alternation-heavy
  patterns, `rx_unstep_*` as a call in a narrow matcher's backtracking, the byte-at-a-time scan
  of the search loop: the next slice.
- **R5 built (Session 357): hono's RegExpRouter.** The router builds one alternation regexp per
  method whose empty captures `$()` mark the routes, matches with `path.match(re)` and finds the
  route with `match.indexOf("", 1)`; its first profile (10 M matches) had the matcher (`rx_run_8`,
  `try_at`) at 15% and the rest around it: the result array's construction 24% (eleven generic
  element stores with their barrier, three `ts_set_pic` additions growing the property vector,
  the slices), the `indexOf` call 20% (lib's `RegExpMatchArray` is an ambient interface over
  `Array<string>`, which the exporter did not take for an array receiver, so the call was a
  dynamic method lookup that probed each fresh result for an own `indexOf` and filled an
  absent-cache entry per match), and the dynamic key reads `matchers[method]` / `matcher[2][path]`
  18% (a string of up to five code units is an immediate value with no cell to cache its key id in,
  so "GET" and "/user" were interned on every read: the hash, the probe, the compare). (1) The
  exporter: `RegExpMatchArray` and `RegExpExecArray` (the ambient symbols only) are array
  receivers (`builtinReceiverKind`, `unionMixesKinds`): methods, element access, `length`, for..of,
  spread and destructuring take the array paths; the named properties keep the generic reads.
  (2) The adapter: `build_result` stores the elements with `ts_array_set_inline` (a fresh array:
  the slot store and the generation test), the named properties are a layout the array adopts at
  creation (`ts_array_adopt_layout`: the shape the keys `index`, `input`, `groups`, `indices` give
  from the empty array shape, the four-slot vector allocated once) and each is one `ts_lit_store`;
  the inline caches remain the fallback when the shape table is exhausted; an empty capture is the
  empty string without a call. (3) The runtime: `ts_key_from_value_slow` caches an immediate short
  string's key id in a direct-mapped table keyed by the value's bits (immutable, never collected,
  so never stale), beside the caches of literal and flat heap strings. Fixture
  `regexp/match_array_typed`. hono's four routers, five alternating rounds each (medians; Node):
  TrieRouter 307 -> 269 ms (246; the key cache serves its `children[part]` reads), RegExpRouter
  146 -> 105 (38), PatternRouter 280 -> 266 (148), SmartRouter 168 -> 129 (41); outputs identical
  to Node. The regexp kernels are within their run-to-run spread (tokenizer 137 -> 137, validate
  94 -> 91, logs 129 -> 127, search 113 -> 109, path_regexps 125 -> 125); vue 1,080 -> 1,077 ms
  (seven alternating rounds, medians; Node 757) and tsc-ts 22.206 -> 22.200 G instructions are
  unchanged, outputs identical. The RegExpRouter's remaining 2.8x is the next profile's subject.
- **R6 built (Session 357): the RegExpRouter's second round.** After R5 the RegExpRouter's
  profile (10 M matches, 119 ns each against Node's ~40) was the matcher 20%, the result array
  21%, the dynamic key reads 16% (the static route map `matcher[2][path]` misses for most
  requests, and the global absent table holds one key per (site, shape): every miss refilled it
  after the probes), roots 3%, and the driver's own reads of hono's `Result<T>` (a union of two
  tuple types behind an alias, which the exporter's printed-type checks saw as the alias name) as
  dynamic property gets with numeric keys. (1) The compiler emits `ALT_FIRST` before an alternative
  with a known non-empty first set ("The alternation's dispatch" above): the next unit outside the
  set skips the alternative without a choice point, and disjoint first sets push none at all; the
  interpreter and the native tier implement it, the engine diff runs 43,593 cases with 0 differ
  in both. (2) `prop_absent_fill_impl` counts a refill of the same site and shape with another key
  as a miss of the site (`prop_ic_note_miss`), so such a site turns megamorphic, and
  `ts_get_dyn_pic_checked` then reads through `ts_get` (the plain lookup) instead of the probes.
  (3) The adapter's `exec_result`: a string input's exec and non-global match root nothing (the
  regexp is read before the allocations, `build_result` roots the string). (4) The exporter: a
  union whose every member is an array (`isArrayKindType`) is an array receiver, so `res[0]` is
  the element path. Fixture `regexp/alternation_dispatch` (disjoint and overlapping alternatives,
  empty and optional ones, anchors and lookarounds first, back references, case-insensitive and
  Unicode first characters over Latin-1 and UTF-16 input, lone surrogates, classes and dots first,
  alternations inside quantifiers and lookbehinds, global and sticky iteration, split and replace,
  a dynamic pattern beside the literal). hono, five alternating rounds (medians; Node): TrieRouter
  273 -> 267 ms (255), RegExpRouter 107 -> 87 (42), PatternRouter 269 -> 243 (163), SmartRouter
  132 -> 111 (43); outputs identical. The RegExpRouter's profile after it (95 ns a match): the
  matcher 24% (the interpreter near its floor, about 2 ns an op: hono's regexps are built at run
  time with `new RegExp`, so the AOT native tier does not apply to them, where V8 compiles them
  just in time), the result array 23%, the dynamic key reads 20% (two reads a match through the
  key, the map and the chain, each a few calls), the driver's loop and the call through the
  `match` function value 14%, `indexOf` 4%. Gates: conformance 665/665 plain, 664/665 strict (`node/timers`, the fixture's own
  recorded race of a 0 ms timer against an immediate under the gate's load; 3/3 alone), 662/662 in
  units mode and under GC protect, the regexp fixtures under `TSAOT_GC_YOUNG_THRESHOLD=1` with
  protect mode, unit, bundler 51/51, bench all within budget, the regexp AOT and link gates, GC
  stress PASSED, the engine diff 43,593 cases 0 differ in the interpreter and the native mode.
  vue 1,073.7 -> 1,072.4 ms (seven alternating rounds each,
  medians; outputs identical; Node 770), tsc-ts 22.200 -> 22.199 G instructions (unchanged; outputs
  identical).
- **R7 built (Session 357): the RegExpRouter's third round.** After R6 (95 ns a match against
  Node's ~40) the profile was the matcher 24%, the result array 23%, the dynamic key reads 20%,
  the driver's loop and the call through the `match` function value 14%. (1) `ts_rt.h`: a dynamic
  read `obj[key]` resolves a string key's id in line (`ts_key_of_string_inline`: a heap string's
  cached id, TS_STR_FLAG_KEY, or the short-key table, now shared with the header) and probes the
  site's cache in line (`ts_prop_ic_probe_dyn_inline`: an entry answers only for its own key and
  shape, since the fixed-key probe takes a shape match as the answer for the site's one key, which
  a site whose keys vary has not: its entry 0 answered another key's read with its slot, a wrong
  value the first A/B caught, fixture `objects/dynamic_key_site_poly`); a megamorphic site goes to
  the plain lookup at once; `ts_key_from_value` takes any heap string's cached id in line; a
  string key needs no root on the way to its id. (2) `ts_new_array_compact`: a result array's
  cell holds its elements (one allocation instead of a cell and an element payload; `array_uses_inline`
  holds, so growth copies out and the collector marks no payload), the elements stored directly;
  a capture of up to five ASCII code units of a flat string is built as an immediate; `keys_init`
  is a flag test. (3) The compiler packs a forward `CHARS` run of characters below 256 as bytes
  after the characters (`RX_OP_PK`), and the narrow matcher compares them eight and four at a
  time (`user/lookup/` was twelve unit compares). (4) `SAVE` pushes its restore entry only when
  the backtrack stack holds a choice point or a lookaround body is running (`rx_ctx.look_depth`):
  with neither, a failure ends the attempt and the registers are reset for the next one; the
  native tier emits the same rule. (5) `Array.prototype.indexOf` with an immediate needle compares
  identities and only a heap string of the same length by content. Fixture
  `regexp/result_array_ops` (the array operations over a compact result array: growth, shift and
  unshift, splice, far stores, truncation, deletion, a result held across collections). The engine
  diff: 43,593 cases, 0 differ in the interpreter and the native mode. Gates: conformance 667/667 plain and strict, 664/664 in units mode and under GC
  protect, unit, bundler 51/51, bench within budget, the regexp gates, GC stress PASSED. hono, five
  alternating rounds (medians; Node): TrieRouter 265 -> 246 ms (264), RegExpRouter 86 -> 71 (38),
  PatternRouter 239 -> 238 (152), SmartRouter 109 -> 93 (49); outputs identical; the regexp kernels,
  vue (1,058 -> 1,057 ms) and tsc-ts (22.170 -> 22.176 G) unchanged. The RegExpRouter's profile after R7 (79 ns a match in the profiling build, 71 in the measured
  one; Node 38): the matcher 28% (the interpreter: sixteen ops and a greedy scan a match, near 1 ns
  an op), the result array and the exec path 22%, the driver's loop and the call through the `match`
  function value 17%, the match closure's body with its `[handlers, match]` pair 12%, the dynamic
  key reads 8%, `indexOf` 4%. What would close the rest: a native matcher for the patterns a
  program builds at run time (a training run's record of their sources, as the profile-guided build
  records hot functions; hono's route regexp is the same at training and in production), the method
  call through an interface-typed receiver with the sized caches (`router.match`), and the
  allocation path of small arrays (the result and the pair).
- **R8 built (Session 358): the RegExpRouter's fourth round, the method call through an
  interface-typed receiver.** The driver's `router.match(method, path)` goes through hono's
  `Router<T>` interface, so the exporter has no class for the receiver and the site took the
  dynamic path: the plain-object probe in line, then `ts_get_pic_checked` out of line for the sized
  instance (two hash probes before the site's sized entry), twice for a prototype method. The
  site cache of a dynamic call (`ts_method_site_ic`, docs/pic_sized_inline_design.md) now serves
  those sites too (`ts_method_lookup_dyn_ic`: the plain-object probe in line as before; a sized
  receiver then takes the site's cache and the lookup out of line, `ts_method_lookup_dyn_fill`,
  and any other receiver the two cached reads as before: a first cut sent every receiver through
  the out-of-line entry, and the extra call on tsc-ts's dictionary-mode checker object cost 0.2%
  of its instructions), and has a second kind: the
  receiver's own struct field holding the function (`TS_MSIC_FIELD`, the byte offset under the
  class word; hono's `match` is a field each router reassigns with its closure), where before a
  class with a field of the method's name kept the lookup. Probing the site's cache in line as well
  (ahead of the plain-object probe) was tried and not kept (RegExpRouter 67.8 -> 66.9 ms,
  SmartRouter 81.4 -> 82.8: noise, for code at every dynamic site). The lookup's prototype walk (`ts_method_lookup_sized_fill`) now tries
  the field key before the method key at each link (an accessor or an assigned property at a
  nearer link, the class's method otherwise: one JS namespace, closest first), where it walked the
  method key alone: a getter in the method position through an `any` receiver threw "is not a
  function" (`classes/dynamic_method_calls`), and a subclass's getter over a base method at a
  base-typed site called the base's method. Two findings on the way: a class without a
  constructor runs its field initializers at each `new` site in the caller's scope, and an arrow
  initializer using `this` took the lexical-this cell of an earlier `new` in the same block (the
  per-block cell cache of commit 49baa73), so `const a = new C(), b = new C()` gave b's arrows a's
  `this` (fixture `classes/field_arrow_this_per_new`; `emitFieldInitializers` scopes the cell);
  and the unit splitter rejected a matcher's `__attribute__((unused))` range table since R6, so
  `--units` failed for any program with a regexp literal whose class has no ranges (the pgo build
  gate had been failing on it). Fixtures `classes/method_site_cache_dyn`,
  `classes/field_arrow_this_per_new`. hono, five alternating rounds (medians; Node): TrieRouter 248.2 -> 246.1 ms (260), RegExpRouter 72.1 -> 68.1 (39), PatternRouter 241.5 -> 241.9 (153), SmartRouter 94.8 -> 81.8 (42); outputs identical.
  Gates: conformance 669/669 plain and strict (the new fixtures included), 666/666 in units mode and under GC protect, unit (the pgo build gate's `--units` case passing again), bundler 51/51, bench all within budget, GC stress PASSED, the regexp AOT and link gates. vue 1,056.4 -> 1,055.0 ms (seven alternating rounds each, medians; outputs identical; Node 773); tsc-ts 22.183 -> 22.182 G instructions (unchanged; outputs identical).
- **R8b built (Session 358): the array literal's allocation.** The match closure's
  `[matcher[1][index], match]` (and `[[], emptyParam]`, the trie's `[curNode]`, every small
  literal of the routers) was an empty allocation and a checked store per element
  (`ts_new_array_site(0)`, `ts_array_set_inline` with its tag, capacity, integrity and generation
  tests). The exporter now lowers a literal without holes or spreads as its elements first (left
  to right, as before) and then the array with its stores by index, and the emitter fuses
  `AllocArray; (Const i; StoreIndex)*` (`array_lits_for`, keyed by the instructions' addresses)
  into one allocation that stores the elements: up to four in registers with holes for the slots
  past the length (`ts_new_array_lit4_site`, four plain stores into the inline slots), five to 64
  in the cell as a compact array through a stack array (`ts_new_array_lit_site`), more than 64
  with an element payload. A first cut took every length through the stack array and a loop over
  the length, and ran more instructions than the allocation and the stores it replaced (hono +1%
  instructions, the TrieRouter +3% wall): the register form for the common sizes is what pays.
  Where the array is allocated is unobservable; the elements' evaluation order is what the
  program sees, and the collector finds the evaluated elements on the native stack (conservative
  roots) or in the frame. `TSAOT_ARRAY_LIT=0` keeps the old order and the separate stores (the
  parity oracle). Fixture `arrays/literal_fused` (every size class, the evaluation order, an
  element that throws, literals in a loop, growth and mutation after the literal in each size
  class, nested literals, holes and spreads untouched). hono, five alternating rounds on one
  toolchain (the knob off against on; medians; Node): TrieRouter 250.7 -> 245.3 ms (260), RegExpRouter 69.0 -> 69.3 (39), PatternRouter 239.1 -> 240.1 (153), SmartRouter 82.6 -> 82.5 (42); outputs identical; the whole run 18.99 -> 18.71 G
  instructions. Gates: conformance 670/670 plain and strict (the fixture included), 667/667 in units mode and under GC protect, unit, bundler 51/51, bench all within budget, GC stress PASSED, the regexp AOT and link gates. vue 1,053.5 -> 1,047.8 ms (seven alternating rounds each, medians; outputs identical; Node 773); tsc-ts 22.183 -> 22.177 G instructions (unchanged; outputs identical).
- **R9 built (Session 358): the native tier for run-time patterns.** The design above, as
  written: the adapter records every pattern compiled without matchers from its site under
  `TSAOT_REGEXP_RECORD` (the training run's variable, set by `tsaot_pgo_train`), the merge writes
  `default.regexps` next to `default.pgo` (`tsaot_regexps_write`), the driver finds it as it
  finds the profile (`--regexps <auto|off|file>`, `TSAOT_REGEXPS`; `--pgo off` is a plain build
  unless the regexps are chosen explicitly), `tsaot regexps <file>` writes the matchers and the
  table (`rx_native.rs emit_table`, the functions `static` in that unit), `tsaot_regexps_table`
  compiles it into `rx_table.o` on the link line next to the engine's objects in every pass, and
  `compile_units` binds a pattern by content on its first compile (`rx_native_table_find`: the
  length and flags, then the units; `TSAOT_REGEXP_TRACE=1` reports each binding).
  `build_tsc_ts_native.sh`'s training records as well (`build.json` `pgo.regexps`), and
  `benchmarks/real/run.sh` takes `TSAOT_REAL_PGO=train|auto|off` (docs/real_projects.md). hono's
  training run records 15 patterns: the RegExpRouter's alternation per method, the
  PatternRouter's regexp per route, the wildcard forms. hono, five alternating rounds on one
  toolchain (medians; Node): the regexps alone (the plain clang build with the table) RegExpRouter
  68.1 -> 60.0 ms (39), PatternRouter 241.9 -> 214.7 (153), SmartRouter 81.9 -> 76.0 (42), the
  TrieRouter unchanged; the trained build (the profile and the regexps) TrieRouter 246.0 -> 179.8
  (260), RegExpRouter 68.8 -> 47.0 (39: 1.2x), PatternRouter 243.7 -> 148.3 (153: below Node),
  SmartRouter 82.0 -> 55.2 (42); outputs identical throughout. What remains of the RegExpRouter's
  1.2x is the driver loop's call through the `match` function value and the closure's own body,
  which V8 inlines into the loop. `tests/pgo_build_gate.sh` covers the record, the file, the
  binding (the trace) and the `--regexps off` and `--pgo off` builds; the engine diff
  43,593 cases, 0 differ in the interpreter and the native mode. Gates: conformance 670/670 plain and strict, 667/667 in units mode and under GC protect, unit (the pgo build gate with the regexps cases), bundler 51/51, bench all within budget, GC stress PASSED, the regexp AOT and link gates. tsc-ts
  22.190 -> 22.182 G instructions (unchanged; outputs identical); the benchmark's own training run records no run-time regexp (tsc-ts's own code builds one only in its timeline tool, which the measured compile never runs, and its file matching, `vfs-match.ts`, uses no RegExp), so the trained build links no table (18.635 G instructions, as before); vue 1,061.7 -> 1,060.0 ms (seven alternating rounds each, medians; outputs identical; Node 773).
- Not yet: the `v`-mode properties of strings (`\p{RGI_Emoji}` and the other six; the emoji
  sequence data is in `build/ucd/17.0.0/emoji-seq/`, emoji 16.0 at the time of writing).

