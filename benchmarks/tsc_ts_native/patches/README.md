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

Measured and not made a patch: a table of the 1,024 values found last in front of the Map of
`SparseLinkTable` (86% of the 1.9 M lookups of the checker of checker.ts name an id found within
that span). In garnet's code an `Int32Array` read and an array read through two fields cost what
the in-line Map probe costs: +1.7% instructions in that checker, cycles -0.2% over fifteen
alternating rounds. The same table as pages of 256 ids: +1.4% instructions.

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
