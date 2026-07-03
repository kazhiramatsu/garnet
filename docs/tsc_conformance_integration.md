# `tsc_conformance` integration: feeding microsoft/TypeScript tests into tsaot

This document designs a new conformance tier that pulls test inputs from
`microsoft/TypeScript/tests/cases/conformance/`. The goal is to dramatically
expand the surface area against which tsaot is tested, with as little tsaot
machinery change as possible.

## What we're working with

5,695 `.ts` files spanning the whole TypeScript language. By construction:

- 9,055 of the matching baselines have `.errors.txt` — tests where tsc
  *expects* type errors to be reported.
- 13,806 have `.js` emit baselines (some of which also have `.errors.txt`).
- Only 120 files use `console.log` anywhere; of those 106 are not
  `// @noEmit: true` (i.e. they actually emit JS that runs at runtime).
- 22 of those 106 are multi-file (use `// @filename:` headers).

So the corpus splits into three classes:

- **Class A** (~85 single-file runtime tests): have `console.log`, no
  `@noEmit`, not multi-file. tsaot can run them and compare stdout to V8
  exactly like the existing exhaustive tier.
- **Class B** (~5,500 type-only tests): no `console.log` (or `@noEmit`).
  No runtime expectation to compare. The only meaningful tsaot outcome is
  "exporter accepted" or "exporter loudly rejected" — never "silently
  miscompiled".
- **Class C** (multi-file, complex flags, decorators, namespaces, etc.):
  defer.

Class A is the focus for v1. Class B becomes a separate tier
(`tsc_loud`) whose pass criterion is binary: tsaot must either lower the
file cleanly OR raise an explicit `unsupported`. A C compile error or an
analyzer crash is FAIL.

## Why Class A is non-trivial

Even with `console.log` present, tsaot has constraints that the original
TypeScript test suite cheerfully ignores:

1. **Test header flags**: `// @target: es5,es2015`, `// @strict: false`,
   `// @strictNullChecks`, `// @allowUnreachableCode`, `// @module: commonjs`,
   `// @sourcemap`. We pick ONE target (es2020), tsaot is strict by default,
   and we ignore sourcemap / module headers.

2. **Multiple `@target` declarations**: e.g. `// @target: es5, es2015` means
   the original tsc harness runs the test once per target. We don't — we run
   it once. This is fine because tsaot's IR is target-agnostic.

3. **`any` and unbound symbols**: tsaot's design (and the user's explicit
   choice) is to LOUDLY REJECT when the type checker leaves something as
   `any` and that any flows into a built-in method dispatch. Tests like
   `additionOperatorWithAnyAndEveryType.ts` (which declares `var a: any`
   and does `a + a`) are EXPECTED to be rejected by tsaot. The harness
   must accept that as a valid outcome — `rejected` is not a `FAIL`.

4. **Carriage returns**: many test files are CRLF-terminated. The existing
   exporter handles that fine via `ts.createSourceFile`, but the harness's
   shell parsing of headers must be CR-tolerant.

5. **Path separators**: existing exhaustive tests live at
   `tests/conformance/exhaustive/<cat>/<name>.ts` and the slug is the
   path with `/` → `__`. The new tier rooted at an external path needs the
   same scheme but reading from a different root.

6. **TSAOT_NET=0 default**: any test that hits the network must not break
   us. The existing fetch tests already gate on this. Class A from
   ms/TypeScript should not touch the network.

## Design

### Two-mode harness extension

I extend the existing `run_conformance.sh` (or add a sibling
`run_tsc_conformance.sh` — choose for clean separation since the test
root is external and the FAIL semantics differ for Class B).

**Mode A (runtime-comparison, like existing exhaustive)**:
- Input: a list of single-file `.ts` paths with `console.log` and no
  `@noEmit`.
- For each: export → IR → emit C → gcc → run → compare stdout to V8.
- Outcomes: PASS (stdout match), FAIL (mismatch, crash, or gcc error),
  REJECTED (exporter raised `unsupported` — counted separately, not FAIL).

**Mode B (acceptance test, "loud or lower")**:
- Input: any single-file `.ts` (the bulk of conformance).
- For each: just run the exporter. Expected: either OK + JSON IR
  produced, or a `[name] UNSUPPORTED: <reason>` line. Anything else
  (exporter crash, OOM, infinite loop) is FAIL.
- This tier measures "does tsaot have a clean error path for every
  TypeScript feature, or does it silently misbehave somewhere?"
- A C compile or run is NOT performed in this mode (we don't have an
  expected stdout to compare).

### Filtering rules (Class A → Mode A)

Include only files that satisfy ALL of:

- Single file (no `// @filename:` header)
- Contains `console.log(` somewhere
- Does NOT contain `// @noEmit: true` or `// @noEmit:true`
- File is under 200 lines (defer the large ones; they're more likely to
  use features we don't support and produce uninformative failures)
- Not under `parser/`, `jsdoc/`, `salsa/`, `declarationEmit/`,
  `emitter/`, `moduleResolution/`, `references/`, `importAttributes/`,
  `importAssertion/`, `importDefer/`, `dynamicImport/`,
  `externalModules/`, `decorators/`, `esDecorators/` — these are not
  testing runtime semantics meaningfully, and most rely on features
  tsaot doesn't support.

Estimated: 50–80 files in Class A passing the filter.

### Filtering rules (Class B → Mode B, pilot)

Include any single-file `.ts` under a curated list of subdirs that
plausibly exercise lowering-relevant features:

- `expressions/` (376 files): operators, function calls, property access
- `statements/` (203 files): for, while, switch, try
- `classes/` (466 files): subset to classDeclarations / methods / etc.
- `controlFlow/` (56 files): narrowing exercises
- `types/` (subset): assignability that might affect codegen choices

Start with `expressions/` and `statements/` as the v1 pilot: roughly
580 files. Set a strict per-file timeout (e.g. 10 s).

### Slug / report structure

The slug is `tscconf__<category>__<subpath-with-__>` mirroring the
existing scheme. Multi-file tests are explicitly skipped at filter time.

### Result classification (Mode B specifically)

After running, summarize four buckets:

- **OK**: exporter produced valid IR
- **UNSUPPORTED**: exporter raised an explicit unsupported error (this is
  the "loud" path — the desired failure mode)
- **CRASH**: exporter threw uncaught exception / timed out / produced
  invalid JSON
- **TIMEOUT**: exporter ran longer than the per-file budget

Only CRASH and TIMEOUT are FAILs. UNSUPPORTED is a legitimate outcome.
OK is the goal but anything we explicitly don't support shows up here too.

### Performance

The existing batch exporter (`--batch list.tsv outdir`) is already O(n) in
the number of tests with a low per-file cost (~18ms after the 1s
cold start). 600 files ≈ 12s of export + however long the C compile/run
takes for Class A. Class B doesn't run C, so 600 files ≈ 12s.

The batch exporter must be robust to one bad file taking out the whole
batch. Currently a parse error or uncaught exception bubbles up — verify
this and fix if needed.

### What I will NOT change

- tsaot's analyzer, runtime, codegen.
- The existing `basic` and `exhaustive` tiers.
- The exporter's filtering of `any` — `any`-related rejections are
  CORRECT outcomes, the harness must accept them.

## Plan

1. **Verify the batch exporter survives partial failures**: feed it a list
   containing one valid test and one syntactically broken test. Check that
   the broken one produces a status line of `ERR ...` and the valid one
   still gets `OK`. If not, fix the exporter's batch loop.

2. **Add `scripts/run_tsc_conformance.sh`**: takes a test root path and a
   mode (A or B) as arguments. Uses the same batch export mechanism.

3. **Add a filtering helper** (`scripts/list_tsc_runtime_tests.sh`) that
   walks a tests-root and outputs the Class A or Class B list per the
   rules above. Keep it standalone so we can audit the filtering.

4. **Pilot Mode A**: run on Class A. Expected outcome: lots of REJECTED,
   some PASS, some FAIL. Investigate FAILs only — REJECTED is fine.

5. **Pilot Mode B (small)**: start with
   `expressions/binaryOperators/additionOperator/`. Confirm classification
   buckets work. Then widen to all of `expressions/`.

6. **Record findings**: every CRASH is a real tsaot bug to fix. UNSUPPORTED
   is data on what feature surface to prioritize next.

## Risks / unknowns

- The TypeScript test corpus has assumptions about diagnostics that don't
  carry over to runtime — many "runtime" tests actually print specific
  things to demonstrate behavior we may not be able to reproduce because
  of unsupported features. Lots of REJECTED is expected and OK.

- The exporter is not currently designed as a long-running batch process
  that survives every kind of input. If one file crashes the batch, we
  lose results. Step 1 above is to verify and fix.

- The TypeScript test inputs may use features that hang our exporter
  (recursive types, deep templates). Hence the per-file timeout in Mode B.

- We're cloning 26 MB of test inputs into the workspace, but NOT into the
  zip. The harness scripts take a `--tsc-root <path>` argument so the
  test inputs live OUTSIDE tsaot/ (e.g. `/home/claude/ts-cases/`).

## Success criteria

- Mode A runs to completion in under a minute, producing a PASS / FAIL /
  REJECTED breakdown. FAIL count is small (or zero — every FAIL is a
  tsaot bug).
- Mode B runs to completion in under a minute on `expressions/`,
  producing OK / UNSUPPORTED / CRASH / TIMEOUT counts. CRASH count is
  ZERO (every crash is a tsaot bug to fix).
