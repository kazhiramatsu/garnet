# Changes to tsc-ts for the garnet build

`scripts/build_tsc_ts_native.sh` copies `packages/tsc-ts/src` of the tsc-ts checkout next to the
garnet entry and applies the patches of this directory to the copy, in the order of their names.
The checkout is left unchanged. `TSAOT_TSC_TS_PATCHES=0` builds the sources as they are (the
build to compare with scriptc's on the same program); `build.json` lists what a build applied.

The patches are against tsc-ts at `c002e8e` ("Build with scriptc 0.4.0"), the commit the benchmark
measures. Each one changes how fast the compiler runs and nothing it reports, and starts with the
reason and the measurement. A patch that no longer applies stops the build and names itself.

| patch | what |
|---|---|
| `0001-merged-symbol-id-bits` | `getMergedSymbol` tests one bit of the symbol's id before the lookup in `mergedSymbols`, which finds nothing for nearly every symbol |
| `0002-cannot-find-name-on-failure` | the "cannot find name" message of an identifier is chosen when its lookup fails, not before every lookup |
| `0003-identifier-text-in-line` | `isThisInTypeQuery` reads the identifier's `text` field instead of calling `getText`; `getResolvedSymbol` asks for the text once |
| `0004-share-statements-with-forks` | a checker thread that is in a huge file when another checker runs out of files shares the file's remaining statements with forks of itself, one for each idle processor (below) |

Measured and not made a patch: a table of the 1,024 values found last in front of the Map of
`SparseLinkTable` (86% of the 1.9 M lookups of the checker of checker.ts name an id found within
that span). In garnet's code an `Int32Array` read and an array read through two fields cost what
the in-line Map probe costs: +1.7% instructions in that checker, cycles -0.2% over fifteen
alternating rounds. The same table as pages of 256 ids: +1.4% instructions.

## Sharing a file's statements (`0004`)

A checker checks a file on one thread, so the largest file bounds the wall clock whatever the
number of checkers: on the TypeScript compiler project the checker of checker.ts (one function of
three megabytes) ran twice as long as the nine others. The garnet build's threads are forks
(`startThreads(..., true)` in `garnet/main.ts`), and a fork of a checker has every type and cache
the checker computed, so the checker of a huge file starts a fork of itself for each processor
another checker leaves idle; the checker and its forks take the remaining statements of the file,
or of its huge top-level function, from a cursor in shared memory. The reasons the diagnostics
are those of one checker, and what keeps a file whole, are at the top of
`src/compiler/checker-split.ts`.

- `TSC_TS_SPLIT=0`: no sharing. `TSC_TS_SPLIT_BODY` (200000) is the least text of a file or
  function that is shared, `TSC_TS_SPLIT_MIN` (50000) the least text left for each process.
- For tests: `TSC_TS_SPLIT_FORKS=n` starts n forks whether a processor is idle or not, after
  `TSC_TS_SPLIT_AT=k` statements; `TSC_TS_SPLIT_FILE=text` shares only files whose names contain
  the text; `TSC_TS_SPLIT_FAIL=i` makes fork i fail after it checked its share, so the checker
  checks that share again. With `TSC_TS_TIMELINE=1` a fork writes "fork start".
- Its check: every test case with forks forced into its first statements against a checker alone,
  `scripts/tsc_ts_corpus_diff.py <binary> <binary> --checkers 2 --env-a TSC_TS_SPLIT=0 --env-b
  TSC_TS_TIMELINE=1,TSC_TS_SPLIT_FORKS=3,TSC_TS_SPLIT_BODY=0,TSC_TS_SPLIT_MIN=0,TSC_TS_SPLIT_AT=2,TSC_TS_SPLIT_FAIL=2,TSC_TS_SPLIT_FILE=tests/cases
  --count-b "fork start"`: 6,537 of 6,537 identical, forks started in 3,749 of them (4,904 with
  two forks at the first statement). Two defects it found while the patch was written: a second
  container shared by the same checker after a function inside the first had shared its own, and
  an interface's once-only check (TS2320) reported at whichever of its declarations a process
  met first.

Measured and not made a patch, for the start of the parse phase (the largest file starts to parse
9 ms after the parse threads start to be forked): the parse threads forked when there is a chunk
for them (the config read moved from 15 to 21 ms, and the libraries' chain of references with
it: the parse phase 5 to 10 ms longer), and the root files matched before the threads are forked
with the largest handed to the first thread (it starts at 10 ms instead of 15: with other chunks
queued behind it on its thread, as the session queues while root files are matched, the phase
was 9 ms longer; with nothing queued behind it, 1 to 2 ms shorter at the median of 25 runs and
no shorter at the minimum). A wide text's line starts by searches instead of the unit loop of
`computeCachesFromUnits`: checker.ts has CR LF line ends in this checkout, which sends
`computeLineStarts` to its own unit loop.

## Writing one

The working copy is a branch of the checkout in a worktree beside it
(`git -C build/tsc-ts worktree add -b <branch> build/tsc-ts-garnet c002e8e`): one commit per
change, built with the worktree as the checkout
(`scripts/build_tsc_ts_native.sh build/tsc-ts-garnet <work>` with `TSAOT_TSC_TS_PATCHES=0`, since
the commits are in it already). A commit becomes a patch as its message followed by
`git diff <commit>~1 <commit> -- packages/tsc-ts/src`.

## Checking one

A change must leave every output as it was. `scripts/tsc_ts_corpus_diff.py <binary A> <binary B>`
compiles each test case of TypeScript's own `tests/cases/compiler` (a TypeScript checkout,
`--root`) with both builds and compares what they print and their exit status; the instruction
A/B (`scripts/tsc_ts_insn_ab.sh`) compares the files they emit for the compiler project. A change
to what a diagnostic says or where gets a case of its own that reaches every branch it touches
(the unresolved names of `0002`: one file with each of the names the message is chosen by, under
`--lib es5`).
