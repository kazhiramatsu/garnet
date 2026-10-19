# RegExp first-character prefilter

Implemented in Session 350 (slice `x24`); runtime only
(`runtime/regexp/ts_regexp_adapter.c`). Kill switch
`TSAOT_REGEXP_PREFILTER=0`; `TSAOT_REGEXP_PREFILTER_LOG=1` prints one line
per compiled pattern with the decision (verification aid).

## Problem

The `native_s350x22` profile (3,265 samples) had 75 samples under
`lre_exec_backtrack`, 36 from `toFileNameLowerCase`
(`/[^İıßa-z0-9\\/:\-_. ]+/g`, tested against every
canonical file name) and 37 from `simpleNormalizePath`
(`/\/\/|(?:^|\/)\.\.?(?:$|\/)/`, tested against every path it normalizes).
Neither pattern has a literal prefix, so the existing literal-prefix fast
path does not apply, and the engine's own search (the bytecode's position
loop) runs the backtracker at every input position: over a lower-case path
the first pattern fails at every position, and the second can only match
at a `/` or at position 0.

## Design

At compile time the adapter parses the first term of every alternative of
the pattern (recursively through groups) and computes the set of code
units that can start a match: a 256-entry table for units below 256, a
`wide` bit for the rest, and a `pos0` bit for an alternative anchored with
`^`. Accepted first terms: a literal (UTF-8 decoded), an escape (`\d \w \s`
and complements, `\n \t ...`, `\xhh`, `\uhhhh`, `\cX`, identity escapes), a
class (ranges, escapes, negation), a group (`(...)`, `(?:...)`,
`(?<name>...)`), each with a quantifier that requires at least one unit
(`+`, `{n,}` with n ≥ 1, lazy variants). Anything else declines the
prefilter and keeps the engine's search: `.`, `$`, `\b`, lookarounds, back
references, property escapes, nullable first terms (`*`, `?`, `{0,n}`, an
empty alternative), nested classes, and the `i`, `m`, `u`, `v` and `y`
flags. A set containing a lower-case letter is declined as well: on
identifiers and paths it would make nearly every position a candidate, and
one engine call per candidate costs more than the engine's internal loop.

An accepted pattern is compiled sticky (like the existing anchored case),
and `ts_regexp_exec_impl` searches: position 0 when `pos0` is set, then
every position whose unit is in the table (a byte scan for Latin-1 input, a
unit scan with the `wide` bit for UTF-16 input), one engine attempt per
candidate. `lastIndex`, global iteration, `replace`, `split`, `match`,
`matchAll` and `search` all go through this function, so their semantics
are unchanged: the first candidate at which the sticky engine matches is
the leftmost match.

## Verification

- Fixture `regexp/first_char_prefilter`: the two compiler patterns over
  mixed paths, classes with ranges, escapes and negation, hex and unicode
  escapes, named groups, `{n,}` and lazy quantifiers, `\W`, `\s`, every
  declined form (`.`, nullable first terms, empty alternatives, `\b`,
  back references, lookahead, the `i`/`m`/`y`/`u` flags, `$`), the entry
  points `split`, `matchAll`, `exec` loops, `lastIndex` after `test`, UTF-16
  inputs with wide units, and 4,000 tests under collection pressure.
  Identical to V8, also under `TSAOT_GC_YOUNG_THRESHOLD=1` and with the
  kill switch; the log confirms the accept/decline decision of every
  pattern.
- The compiler itself: the log over a `--noEmit` run shows the two hot
  patterns and `\s+`, `\/\.\//`, `[^\w\s/]`, `[.*?]` and the JSON escape
  class accepted; the `^`-anchored ones stay on the anchored path; the
  `i`/`m` and `.`-first ones stay on the engine search.
- Kernel `benchmarks/patterns/path_regexps.ts` (`toFileNameLowerCase` and
  `simpleNormalizePath` over 96 paths, 3,000 rounds): native 844 → 339 ms
  with the prefilter, Node 112 ms.
- Compiler A/B, `x24` against `x23` (alternating three runs, outputs
  validated, diagnostics zero): 5.689 → 5.613 s median wall (−1.3%, the
  three pairs −2.1%, −1.2%, −2.0%), Node 3.27 s.

## Pitfall

`scripts/lib/regexp_link_flags.sh` builds the adapter object only when it
is missing (`$work/regexp/ts_regexp_adapter.o`), so after a change to the
adapter the cached objects under `build/` (the diff helper's
`build/regexp/`, the conformance work directories, a relink's copied
`regexp/` directory) must be deleted or they silently keep the old code.
