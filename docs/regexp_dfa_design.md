# The regexp engine's DFA tier (design, Session 360; measured, not kept)

**Outcome (Session 360, "Measured" below):** D1 was built and verified (the engine diff 0 differ with
10,164 cases on the DFA) and was 46% slower than the interpreter on hono's RegExpRouter with the same
instruction count: a DFA walks a chain of dependent loads per character, where the interpreter's
fast ops (word-wise literal runs, tight class loops, the first-character dispatch) already take
hono's route regexps in chunks. The tier is not in the engine; the work is kept on the local branch
`attic/regexp-dfa-d1` for linear-time matching as a goal of its own.

Kaz's direction (2026-10-30): V8 compiles hono's one big route regexp to native code just in time;
garnet's VM should narrow by the static parts of a pattern with a string comparison, and better, run
a DFA built just in time for the regular part of a pattern. This document is the design: which
patterns a DFA can take with ECMAScript's semantics intact, how the DFA is built and run, how it
sits beside the interpreter and the native tier (docs/regexp_vm_design.md), the slices and their
verification.

## Where it pays

A pattern the program builds at run time (`new RegExp(src)`: hono's route regexps, a tokenizer's
keyword alternation) runs on the interpreter unless a training run recorded it (R9's table). The
interpreter executes a handful of ops per input character (a text op's dispatch, the alternation's
first-character guards, a choice point per alternative that may match, the capture saves with their
restore entries); a DFA executes one table step per character and nothing else. hono's GET route
regexp in the router benchmark is

```
^\/(?:event\/([^/]+)(?:$()|\/comments$())|map\/([^/]+)\/events$()|static(?:|\/.*)$()|
     user\/lookup\/(?:email\/([^/]+)$()|username\/([^/]+)$()))
```

and every match of it is one left-to-right pass a DFA can make. In the plain build's profile (10 M
matches, Session 360) the matcher is a fifth of the time and the code around it the rest (the result
array, the call path, the closure); the trained build's matchers are native already (R9). The DFA's
value is therefore twofold: the interpreter's patterns at the native tier's speed without a training
run, and linear-time matching for every regular pattern (no catastrophic backtracking).

## What a DFA can do under ECMAScript's semantics

The semantics are the backtracking ones (docs/regexp_vm_design.md "Semantics"): alternatives left to
right, greedy before lazy, the first successful path's captures, a quantified group's captures reset
at each iteration, an iteration that matches empty failing once the minimum is met. A DFA recognizes
the set of matching strings; what decides between the answers of the backtracking order is the
order in which the NFA's paths are tried, so a DFA reproduces it when it keeps that order:

- **One-pass patterns.** A pattern is one-pass (RE2's term) when, at every position and for every
  next input character (or the end of the input), at most one of the NFA's paths can continue. Then
  priority never chooses between live paths, the captures are those of the one path, and the DFA's
  transitions can carry the capture actions: a transition is (the next state, the capture registers
  to set to the current position, the groups to clear). hono's route regexps are one-pass by
  construction: the router refuses ambiguous routes when they are added (a parameter beside another
  child of the same trie node is a PATH_ERROR, and SmartRouter takes another router), the trie makes
  every alternation's alternatives start with distinct characters, and the wildcard forms are
  decided by the next character or the end (`(?:|\/.*)$`: `/` takes the second alternative, the end
  the first).
- **The match against continuing.** In a one-pass DFA a state may be accepting and continuing at
  once (`a+` after an `a`). The backtracking order says which comes first: greedy continues and
  returns to the acceptance only when the continuation fails, lazy accepts at once. The DFA keeps
  the last acceptance (the position and a copy of the capture registers) while a greedy path
  continues, and stops at an acceptance that has priority.
- **Other regular patterns.** A pattern that is regular but not one-pass (an alternation whose
  alternatives overlap, `(a|ab)c`) needs the DFA states to be ordered sets of NFA states, the
  lower-priority ones dropped behind an acceptance (the leftmost-first lazy DFA of RE2 and Rust's
  regex). Such a DFA answers `test`, `search` and the match bounds; the captures come from the
  interpreter run once, anchored at the found start. This is a later slice.

Not regular, so never a DFA: back references, lookaround. They stay on the interpreter.

## Eligibility (at compile, over the AST)

D1 takes a pattern whose nodes are all of these, and leaves everything else to the interpreter:

- `RX_N_CHAR`, `RX_N_DOT`, `RX_N_CLASS` without `v`-mode strings, under no `i` (D2) and outside
  `u`/`v` mode (D2: a code point above the BMP is two units of a UTF-16 input);
- `RX_N_SEQ`, `RX_N_ALT`, `RX_N_GROUP` (capturing or not), `RX_N_EMPTY`;
- `RX_N_QUANT` whose body cannot match empty (`min_len > 0`: the empty-iteration rule never applies)
  and whose expansion stays within the NFA budget (a counted repetition is unrolled: `{n,m}` as n
  copies and m - n optional ones, `{n,}` as n copies and a loop);
- `RX_N_BOL` and `RX_N_EOL` without `m` (D2 adds `m`, `\b`, `\B`: a bit of the previous character's
  class in the DFA state).

The budget: the NFA's states at most 4,096 (a few times the largest route table measured); past it,
the interpreter.

## The NFA

Built by `rx_compile.c` right after the bytecode when the pattern is eligible (the AST lives in the
compile's arena, which is freed afterwards), and stored in the program: a Thompson NFA over the
AST with ordered epsilon transitions (an alternation's alternatives in order; a greedy loop's body
before its exit, a lazy loop's exit first), consuming states carrying a character set (an index into
the program's sets, the bitmap below 256 and the ranges above), and epsilon states for the capture
saves (`SAVE reg`), a quantified group's clear at each iteration (`CLEAR lo hi`, as the bytecode's
`CLEAR`), the anchors (`BOL`: the position is 0; `EOL`: the position is the end) and the
acceptance. Its cost is linear in the pattern and paid once per distinct (source, flags), as the
bytecode's is.

## The one-pass DFA, built just in time

On the program's first exec (not at compile: a pattern that never runs costs nothing), the engine
attempts the one-pass construction (RE2's onepass): starting from the anchored start, for each
consuming NFA state reachable, the epsilon closure of its successor is walked in priority order,
collecting the actions met on the way (saves, clears) and the conditions (an anchor); for each
character class at most one consuming state may be reached, else the pattern is not one-pass. The
DFA state is the consuming NFA state; the table row has an entry per character class: the next state
and an index into the action lists (0: none), or 0 for no transition. The acceptance of a state
records its actions, its condition (none, or the end of the input for `$`) and its priority against
continuing. A pattern that is not one-pass, or whose table would pass the budget (states x classes
at most 64 K entries), is marked so and never tried again; it stays on the interpreter.

The alphabet is the pattern's character classes, not the code units: the boundaries of every set
the NFA tests partition the units into equivalence classes (RE2's byte classes). A 256-entry table
maps a Latin-1 input's byte to its class; a UTF-16 input's unit above 255 is mapped through the
sorted boundaries above 255 (usually one class, "anything else").

## The run

`rx_exec` keeps its search loop (the prefilters, the quick check, the anchored and sticky starts)
and calls the DFA where it calls `try_at`'s matcher today: an anchored or sticky pattern makes one
run from the start, an unanchored one a run per candidate position. A run on a Latin-1 input:

```
st = start; for (i = pos; ; i++){
  if (acc[st]) record or stop (the acceptance's condition and priority);
  if (i == len) break;
  e = tab[st * ncls + cls[in[i]]];
  if (!e) break;
  if (e->act) apply(e->act, i);    /* SAVE: regs[r] = i; CLEAR: regs[lo..hi] = -1 */
  st = e->next;
}
```

The capture registers are the caller's array itself (no backtrack stack, no restore entries, no
copy at the end). A UTF-16 input runs the same loop with its class lookup.

## Beside the interpreter and the native tier

A program with native matchers (a literal's, R3; the training table's, R9) keeps them; the DFA is
for the programs without: `try_at` takes `native[wide]`, then the DFA, then the interpreter, each a
predictable branch per attempt. `TSAOT_REGEXP_DFA=0` turns the tier off at run time (the A/B on one
binary); `TSAOT_REGEXP_DFA=force` makes the engine diff and the conformance corpus use it wherever a
pattern is eligible, and `TSAOT_REGEXP_TRACE=1` reports each program's DFA decision (built, not
one-pass, over budget, ineligible and why).

## Verification

- The engine diff (`tests/regexp/rx_diff.mjs`, 43,593 cases) in a `--dfa` mode: the driver forces
  the tier and reports how many cases ran on it; every result must be V8's. Its seeded random
  walk over a small alphabet adds the patterns where priority and the empty-iteration rule matter.
- The conformance corpus (`tests/conformance/exhaustive/regexp/vm_*.ts`) under `force`.
- Fixtures for the eligible forms and every fallback (a back reference, a lookahead, a quantified
  body that matches empty, an alternation that is not one-pass, a pattern over the budget, a UTF-16
  input, captures reset in a quantified group, greedy and lazy acceptance).
- hono's routers (plain and trained), the regexp kernels of `benchmarks/patterns/regexp_*.ts`, vue,
  tsc-ts (no run-time regexps in its measured compile: unchanged).

## Slices

- **D1** — the NFA at compile, the one-pass DFA at first exec, the run on Latin-1 and UTF-16 (non-`u`)
  input, captures and clears, `^`/`$` without `m`, greedy and lazy acceptance; the knobs, the trace,
  the diff mode; hono's routers.
- **D2** — `i` (the classes canonicalized as the interpreter's `CHAR_I`/`CLASS_I` do), `m`, `\b`/`\B`,
  `u`/`v` code points.
- **D3** — the leftmost-first lazy DFA for regular patterns that are not one-pass: `test`, `search`,
  the match bounds of `exec`, `replace` and `split`, the captures by one anchored interpreter run.

The code around the matcher (the result array, the call path; Session 360's profile) is improved
beside these slices, as Kaz asked: those costs are the larger share once the matcher is native.

## Measured (Session 360): not a win on hono's routes

D1 was built as designed above (the NFA at compile, the one-pass DFA at the first exec, the run in
`try_at` ahead of the interpreter) and verified: the engine diff's 43,593 cases with 0 differences,
10,164 of them run on the DFA (254 patterns not one-pass, the rest ineligible), the regexp fixtures
38/38 with the DFA forced ahead of the native matchers. On the RegExpRouter-only driver (10 M
matches, the plain build, alternating runs on one binary with `TSAOT_REGEXP_DFA=0`): the
interpreter 628 ms, the DFA 918 ms (+46%), the instruction counts within 1.2% of each other. The run
is a chain of dependent loads per character (the unit's class, the transition, the next state's
row); keeping the tables in registers did not change it. The interpreter takes hono's route regexps
in chunks: a literal run compared a word at a time (`CHARS`), `[^/]+` scanned by a tight C loop, the
alternatives skipped by their first character without choice points (`ALT_FIRST`). A DFA competes
only with the same accelerations (a state's literal run compared at once, a self-loop scanned), and
then it is the interpreter's fast ops with the alternation dispatched by one table read instead of
a test per alternative: a few nanoseconds per match at best, against a matcher that is a fifth of
the plain build's match and nothing of the trained build's (native, R9). The tier is not kept. The
work (the local branch `attic/regexp-dfa-d1`: `runtime/regexp/rx_dfa.c` and its wiring) stays for
the day linear-time matching is wanted for its own sake (a pattern that backtracks catastrophically), where the DFA's
speed on ordinary patterns would not matter. The work goes to the costs around the matcher.

