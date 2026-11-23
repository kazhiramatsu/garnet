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
| `0005-parse-queue-by-bytes` | the parse threads' chunks are bounded by their bytes, the automatic type directives and the files they add go out with the libraries, the large files the largest first (below) |
| `0006-files-without-function-bodies` | a file that is mostly one function is parsed without that function's body for the checkers of the other files, which then start when the other files are parsed; the checker that takes the file parses it in full (below) |
| `0007-near-link-tables` | the symbol an identifier resolved to, and the links of a symbol, are kept in pages of 64 ids instead of a map |

`0007`: `SparseLinkTable.get` was 5.5 to 6.6% of the samples of every checker process, nearly all
of them at the read of the map's index (a table as large as everything stored, read where the id's
hash says) and the branch after it; 2.3% of a checker's time was `getResolvedSymbol`'s lookup alone.
The ids of a file's nodes are consecutive, so pages of 64 ids hold the lookups of one function near
each other. Over eleven alternating runs, the checkers and forks together: with the resolved
symbols and the symbols' links in pages, instructions 13.762 to 13.600 G (-1.2%), cycles 5.442 to
5.268 G (-3.2%), page faults +0.9%; with all five tables in pages, instructions +0.7%, cycles -2.6%,
page faults +4.4% (the links of nodes, the resolved types and signatures are stored for few ids of a
page, and a page is 64 slots to fill): those three stay maps. With one checker for every file
(`--singleThreaded`) the two tables in pages are +0.3% instructions and -1.5% cycles.

Measured and not made a patch: a table of the 1,024 values found last in front of the Map of
`SparseLinkTable` (86% of the 1.9 M lookups of the checker of checker.ts name an id found within
that span). In garnet's code an `Int32Array` read and an array read through two fields cost what
the in-line Map probe costs: +1.7% instructions in that checker, cycles -0.2% over fifteen
alternating rounds (one process's cycles, which vary by more than that between runs on this
machine: `0007` was measured on the sum over twenty processes). The declared signatures of a huge
function's nested functions resolved by its checker before the first statement, so that its forks
inherit them (`0004`): instructions and cycles of the checkers and forks unchanged (13.683 and
13.676 G, 5.296 and 5.281 G): what the forks resolve again is not the signatures.

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

## The parse threads' queue (`0005`)

The checkers start when every file is parsed, and with `0006` the largest file no longer decides when
that is: the other files do. On the TypeScript compiler project they were done 12 to 15 ms before
`checker.ts`, 35 ms after the root files were queued, for 25 ms of work on nine threads:

- The 78 root files went out in chunks of sixteen files, 2.4 MB each: four chunks on three threads
  (one of them queued behind another), 25 ms each, while six threads had nothing left. A chunk is
  now also bounded by its bytes (192 KB, about 3 ms).
- The automatic type directives (`types: ["node"]`) were one job in the first chunk of root files and
  came back with it 29 ms later, with the 65 files of `@types/node` to queue, and those with
  `undici-types`. They go out with the libraries now, and so does the package's entry file.
- While root files are matched the main thread cannot hand out chunks as threads finish, so it queues
  chunks on the threads ahead: twelve each. For a match that takes a millisecond that was the whole
  queue, on the threads that happened to be idle (with small chunks: five behind `checker.ts`). A
  thread now holds as many bytes ahead as it loads in the time the match has taken so far, and the
  first files a match finds wait 2 ms for the others, so that the large ones go out the largest first.

The order in which files are loaded ahead changes nothing the program is built from (`takePreparedFile`).

## Files without function bodies (`0006`)

`checker.ts` is 3.15 MB, 3.10 of them the body of `createTypeChecker`. Its parse thread read, parsed,
bound and published it in 45 ms; the other 248 files were parsed 12 to 15 ms earlier (30 with `0005`),
and the checkers of those files waited for a body none of them reads. The parse threads now leave
such a body out (`Parser.skipFunctionBlock`): of a function declaration at the top of a TypeScript
module, with a return type, whose body has a megabyte of text or more. The file without it takes its
thread 7 ms and stands in for itself (`SourceFile.skippedBodies`): the program is built and the
checkers start when the other files are parsed. The checker that takes the file parses it in full,
in its own heap, and continues with a program of its own in which the file is whole
(`withFullFile`, over `Program.updateFile`); it starts on the file's statements later than it would
have and shares more of them with forks of itself (`0004`).

What keeps the diagnostics those of files parsed in full:

- **Where the body ends is a guess that is checked.** Nothing between the braces is read: the body is
  taken to end at the first line that starts with `}`, in a declaration that starts a line and whose
  `{` ends one. The checker's own parse says whether it does (the same statements at the top of the
  file, each from and to the same character, and no syntax error); if not, or if the file in full
  imports what the file without the body does not (`import()` in the body), the command line is run
  again with every file parsed in full (`compileAgainInFull`). Of the 3,764 candidate functions of
  TypeScript's `src` the guess is right for all.
- **The checkers of other files read the signature, not the body.** A body's declarations are in scope
  in its function's signature as values, not as types: a signature with a `typeof` query or a
  computed property name, or with a parameter whose type is that of its initializer or binding
  pattern, keeps its body. A function without a return type keeps it (its return type is its body's),
  and so does every function that is not a statement of the file. A file that is a module only by what
  a body holds (`import.meta`) is parsed in full, as is one with a syntax error outside the bodies.
- **Only where every use of the files is a check on a checker thread:** not when the program emits or
  reports declaration diagnostics, is incremental or watched, lists files or counts nodes, has one
  checker, or is not checked for a syntax error elsewhere (those compile again in full, or never
  leave a body out).

- `TSC_TS_SKELETON=0`: no body is left out. `TSC_TS_SKELETON_BODY` (1000000) is the least text of a
  body that is. For tests: `TSC_TS_SKELETON_BODY=1` leaves out every body that may be, and
  `TSC_TS_SKELETON_FAIL=1` makes the checker's own parse disagree, so that the compile starts again.
  With `TSC_TS_TIMELINE=1` a parse thread writes "skeleton", the checker "full file parse" and
  "full program", the main thread "compiling again in full".
- Its check, `scripts/tsc_ts_skeleton_check.sh <binary> <TypeScript checkout>`: the cases of
  `benchmarks/tsc_ts_native/tests/skeleton` (errors in and outside bodies, a `}` at the start of a
  line of a template literal, a signature that reads its body, a syntax error and an `import()` in a
  body, a script, overloads and generators, two files that stand in for each other) and the compiler
  project under option sets that report 1,391 and 762 diagnostics, where with every body left out 69
  of the 78 files stand in for themselves: all the same as in full. And the corpus on two checkers,
  `scripts/tsc_ts_corpus_diff.py <binary> <binary> --checkers 2 --env-a TSC_TS_SKELETON=0 --env-b
  TSC_TS_TIMELINE=1,TSC_TS_SKELETON_BODY=1 --count-b "full program"`: 6,537 of 6,537 identical, a
  file checked in full by its checker in 75; with `TSC_TS_SKELETON_FAIL=1` and `--count-b "compiling
  again"`, 6,537 identical and 75 compiled again. (A corpus case is one file, so the corpus checks
  the parse and the replacement, and the cases and the project what other files read.)

The garnet build gives a checker the young budget for the files it may parse in full
(`garnet/main.ts`, 32 bytes a character on top of the 128 MiB): a collection in the middle of the
check would promote the file's nodes.

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
