# Profile-guided builds by convention (`default.pgo`)

Session 352. A profile-guided build of tsc-ts ran the TypeScript compiler
project in 15.7% fewer instructions than the plain build (docs/gc_v3_plan.md,
"The remaining levers, measured"), the largest single lever left after the
generated-code and runtime slices of the session. This document is how garnet
exposes it without making anyone think about it.

## The convention

A file named `default.pgo` next to a program's entry file is applied to every
build of that program, the way Go applies a main package's `default.pgo`
(`go build -pgo=auto`). Nothing else changes: no flag, no second pass, the
build takes a few percent longer (the compiler reads the profile) and the
driver's last line says `(profile-guided: <path>)`. With `-p`, the project's
tsconfig directory is the second place looked at. `--pgo off`
(`TSAOT_PGO=off`) ignores the file; `--pgo <file>` applies another profile.

Creating the profile is a one-time step, done by one person for a project:

```sh
./garnet --pgo-train '"$TSAOT_PGO_BIN" input.txt' src/main.ts
```

builds an instrumented program, runs the command on it (the executable is
`$TSAOT_PGO_BIN`, also `$1`; the command runs in the current directory), merges
the raw profiles, writes `default.pgo` next to the entry file and builds the
program again with it. The file can be committed; every later `./garnet
src/main.ts` of anyone on the team applies it. Rebuilds of edited sources keep
applying it: clang matches functions by symbol name and control-flow hash, a
changed function silently loses its profile and keeps its plain optimization
(the warnings are off), and the profile is refreshed by running the training
again.

Why no automatic training: a run the compiler invents (the program with no
arguments, say) records the real hot paths as cold, and a profile that says
the wrong thing produces a slower program than no profile. Someone who knows
the program names a representative run once.

## The benchmark build

`scripts/build_tsc_ts_native.sh` is profile-guided by default: the
instrumented build compiles the TypeScript 6.0.3 compiler project with one
checker (the measured workload), the profile goes to `<work>/default.pgo` and
`build.json` records it (`pgo.mode`, `pgo.profile`, `pgo.trained_with`).
`TSAOT_PGO=off` builds plain, `TSAOT_PGO=<file>` applies a given profile (a
reuse or staleness experiment), `TSAOT_PGO_TRAIN='<cmd>'` trains with another
workload (the executable is `$TSAOT_PGO_BIN`). Without the training inputs at
hand (`build/typescript_603` and the lib directory, `TSC_TS_LIB_DIR` or the
checkout's `@scriptc` package) the build stops with the two remedies rather
than quietly producing a plain binary. The export and the emission run once;
the two compile-and-link passes and the training run are the added cost.

Build time on the development machine (three compile jobs, `nice 12`), from
the file times of the session's builds:

| phase | plain | two-pass |
|---|---|---|
| export + emit (one thread) | 14 s + 39 s | the same, once |
| compile + ThinLTO link | 33 s | 48 s instrumented + 2 s training + 40 s with the profile |
| total | about 89 s | about 143 s |

The instrumented tsc-ts runs the workload in 1.76 s against 1.22 s (1.44x)
and is 64 MB against 41 MB.

## Mechanics

- `scripts/lib/pgo.sh`: `tsaot_pgo_profdata` (llvm-profdata: `$PATH`, the
  compiler's `-print-prog-name`, `xcrun`, versioned installs),
  `tsaot_pgo_use_flags` (`-fprofile-use=<file>` and the three warnings off:
  unprofiled, out-of-date, backend-plugin), `tsaot_pgo_gen_flags`,
  `tsaot_pgo_merge`, `tsaot_pgo_train` (runs the command with `TSAOT_PGO_BIN`
  and `LLVM_PROFILE_FILE=<dir>/%p.profraw`, so forked checkers write their
  own files, then merges; a command that exits non-zero still yields its
  profile, a command that wrote none fails).
- Profiles are clang's: `tsaot_pgo_supported` tests the compiler, a
  `default.pgo` under another compiler is reported and ignored, `--pgo-train`
  refuses.
- Both passes compile the runtime object and the program with the same flags
  plus the pass's own (`-fprofile-generate=<dir>` / `-fprofile-use=<file>`);
  the instrumentation hashes functions at compile time, so ThinLTO stays on in
  both. mimalloc's object is built before the pass flags apply and is not
  profiled (its cache is keyed by compile command, not by profile content).
- Caches: `tsaot_units_build` keys an object by the profile's content when the
  compile command carries `-fprofile-use=` (a new profile recompiles, the same
  one hits); the driver's runtime object key includes the profile's checksum;
  an instrumented pass is keyed by its run's directory and never reused, so it
  bypasses the shared caches (its objects go to the pass directory, removed
  with it).
- `tests/pgo_build_gate.sh` (the unit gate and `ci_fast.sh`): the trained
  program prints what the plain one prints, `default.pgo` is written next to
  the entry file and applied by a later plain build, `--pgo off` ignores it,
  the unit cache hits on the same profile and recompiles on a changed one, a
  training run that writes no profile fails loudly and leaves no instrumented
  executable behind.

## Caveats

- **Symbol stability.** A generated function is `fn_<id>_<name>` with the
  exporter's sequential id, so adding a function early in a program renumbers
  those after it, and a stale profile then misses them all (clang matches by
  name). Reuse across edits is worth what the names are worth; a name derived
  from the module path and the declaration (a hash, with a disambiguator)
  would let a profile survive unrelated edits. Not done in this slice.
- **The benchmark profile comes from the workload it is measured on.** That is
  how a compiler is tuned (and what the benchmark's other side does); the
  cross-input measurement below says how much of the gain survives a different
  training input.
- **Determinism.** The training run's counts vary slightly between runs (the
  compiler's timing paths), so two builds of the same code are not
  byte-identical; the build-to-build variation below is the floor of what an
  A/B of two profile-guided builds can resolve.
- Programs no single command represents (a server under load) want a profile
  sampled in production (AutoFDO, Linux `perf`); out of scope here.
- `scripts/build_typescript_native.sh` keeps its single pass (its checkout is
  not on this machine to test against); the same `TSAOT_PGO` treatment applies
  when it is rebuilt.

## Measurements

One checker on the TypeScript 6.0.3 compiler project, eight pairs, the
development machine at `nice 12`, outputs identical throughout. "Plain" is
the slice AY build (`TSAOT_PGO=off` today).

| build | instructions | cycles | wall |
|---|---|---|---|
| plain | 22.47 G | 5.29 G | 1.23 s |
| trained on the compiler project (the default) | 18.85 G (0.839) | 4.41 G (0.832) | 1.02 s |
| the same, trained again | 18.85 G (1.0000 of the above) | 4.40 G (0.998) | 1.02 s |
| trained on the frozen TS analyzer's project instead | 20.47 G (1.086 of the default) | 4.87 G (1.104) | 1.13 s |

The build-to-build variation of two trainings of the same code (the binaries
and the profiles differ) is below 0.01% in instructions and 0.2% in cycles:
an A/B of two profile-guided builds resolves a slice of a few tenths of a
percent. A profile from a different input (tsc-ts compiling the 11.8k-line
analyzer_ts project, which it does not even type-check cleanly) keeps about
half the gain: 8.9% fewer instructions than plain, 8.6% more than the
in-sample profile.

Against scriptc's native tsc-ts directly (the same checkout's
`packages/tsc-ts/dist/tsc`, both `--singleThreaded`, interleaved, eight
pairs): scriptc 18.33 G instructions, 4.50 G cycles, 1.03 s; garnet's trained
build 18.86 G (1.029), 4.41 G (0.980), 1.01 s (0.981). The first build of the
session to finish the workload in less time than scriptc; 2.9% more
instructions, 2% fewer cycles. The other modes, five pairs each, say where
the gap remains:

| mode | scriptc | garnet (trained) | garnet / scriptc |
|---|---|---|---|
| one thread, emitting | 18.36 G, 4.52 G cycles, 1.01 s, 394 MB | 18.91 G, 4.44 G, 1.00 s, 611 MB | instructions 1.030, cycles 0.980, wall 0.990, memory 1.55 |
| one thread, `--noEmit` | 11.16 G, 2.86 G, 0.65 s, 299 MB | 12.02 G, 2.94 G, 0.66 s, 423 MB | 1.077, 1.028, 1.015, 1.41 |
| four checkers, emitting | 0.43 s | 0.53 s | wall 1.233 (the forked checkers' counts are not in the parent's) |

The win is the emit phase's: checking alone garnet is 3% behind in cycles and
8% in instructions, the four-checker compile 23% behind in wall, and the
peak memory 1.4-1.55 times scriptc's.
