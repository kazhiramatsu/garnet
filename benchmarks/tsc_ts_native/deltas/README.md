# Delta ports: what tsrs has that tsc-ts does not

tsc-ts is a TypeScript port of the TypeScript 7 compiler (tsgo). [tsrs](https://github.com/oxc-project/tsrs)
(Apache-2.0) is a Rust port of the same compiler, with changes of its own that make it faster and leave
what it reports unchanged, each with a note that says why it is exact and what it measured. The two ports
follow the same source function by function, so such a change can be brought over by itself: a **delta**.
This directory is the list of them (`catalog.json`) and the procedure; `scripts/tsc_ts_delta.py` is the
harness that runs the mechanical part.

Porting tsrs as a whole was weighed and not chosen (Session 367): on the TypeScript 6.0.3 compiler project
tsrs runs 4.9 G instructions on one thread and tsc-ts under garnet 13.3 G, and most of that distance is what
Rust gives tsrs (arenas, no collector, its build), which a port to TypeScript does not bring along. The
deltas are the part that does.

## The procedure

One delta is one commit of the tsc-ts working copy and one patch of `../patches`. The steps:

1. **Catalog.** A candidate has an entry in `catalog.json`: where tsrs describes it (paths relative to a
   tsrs checkout: the note, the source), what tsrs measured, its exactness argument in a sentence, the
   tsc-ts files it would touch, and a pattern of function names for the probe. `status` lists them.
2. **Probe.** `probe <pattern>` gives the share of one thread's samples spent in the functions the
   technique shortens, on the compiler project: its upper bound here. A technique whose bound is under
   0.3% is recorded as such (`reject --reason`) and not written. tsc-ts has changes of its own, so the
   probe also finds what is already there (`reject --status present`).
3. **Write.** `new <id>` makes a git worktree of the working copy on a branch `delta/<id>`. The change is
   written there from tsrs's note and source, with the exactness argument in a comment where the shortcut
   is, as the patches' README asks. A cache or a memo gets a shadow mode where tsrs has one (an
   environment variable that computes the answer both ways and stops on a difference): the corpus then
   runs under it.
4. **Evaluate.** `eval <id>` builds the commit and its parent (plain builds, kept by commit) and compares
   them: what each reports on the compiler project under three option sets, on one thread and in the
   default run; instructions and cycles on one thread; instructions and cycles summed over the processes
   of the default run; a spread sample of the corpus (400 cases). It writes a JSON record and a verdict:
   `keep` (exact, and 0.2% or more fewer instructions one way without 0.2% more the other), `neutral`,
   `worse`, `mixed`, or `NOT EXACT`. Its exit status is 0 when the commit is exact.
5. **Corpus.** `eval <id> --corpus full` runs every case (6,537 of TypeScript 6.0's `tests/cases/compiler`,
   a quarter of an hour). A commit that touches how the checkers and the parse threads share work also
   runs the corpus against itself with statements shared by force (three ways) and function bodies left
   out by force (two ways), as the gates of the patches do.
6. **Land or reject.** `land <id> --name <slug>` puts the commit on the patches' branch, writes
   `../patches/NNNN-<slug>.patch` and marks the entry with its measurements. `reject <id> --reason ...`
   records why not, with the record's numbers when there is one. Either way the entry says what was found,
   so nobody measures it again.

After a batch has landed, the gates of the patches' README (the full corpus on the build made from the
patches, the fixtures, the benchmark) and a wall clock comparison on a quiet machine close the slice.

## What a delta is judged by

- **Exactness is the corpus and the compiler project's reports, byte for byte, against the parent.** The
  parent's parent is the chain back to the unpatched sources. An argument in a comment is necessary and
  not sufficient: tsrs's member-order port passed every project and failed one conformance case.
- **Speed is instructions**, on one thread and summed over the default run (the main process, the parse
  workers, the checkers and their forks, each by its own counter). One process's count repeats within
  0.1%; the wall clock follows the machine's load and is taken only with `--wall N`, for a quiet machine.
  A structural change (who checks what, and when) can move the wall clock without moving the instructions,
  and the other way: such a delta is not landed on the instruction count alone.
- A delta that needs the other port's history (tsrs's `--fast` caches are off under tsgo's history) is
  measured like any other and landed only if the corpus agrees.

## Running it unattended

Every step is one command with an exit status and a JSON record
(`build/tsc_ts_delta/evals/<commit>.json`: `exact`, `verdict`, `one_thread.instructions_ratio`,
`default_run.instructions_ratio`, `corpus[]`, `reports{}`), a build and a run never overlap (one lock for
all invocations, nice 12, three jobs, a time limit a step), and builds are kept by commit, so an agent, or
several with a worktree each, can walk the catalog: take the next candidate, probe, write, `eval`, and
`land` or `reject` on the verdict. What stays a person's or a reviewing agent's is the exactness argument
of step 3 and the decision on a `mixed` verdict.

## Environment

`TSC_TS_WORK` (the working copy, `build/tsc-ts-garnet`: the patches' README says how it is made),
`TSC_TS_PROJECT` (`build/typescript_603/source`), `TSC_TS_LIB_DIR`, `TSC_TS_CORPUS`
(TypeScript's `tests/cases`; without it the corpus steps are skipped and nothing can land),
`TSC_TS_DELTA_HOME` (`build/tsc_ts_delta`: builds, records, worktrees; a build is a few hundred megabytes
and is removed by hand).
