# tsaot — Handoff for V8-diff conformance work (for Claude Code)

You are continuing the conformance work on **tsaot** (an AOT compiler from TypeScript → C, written in
TypeScript, with self-hosting as a goal).

Reading this document alone is enough to start work immediately. First run "Setup", understand the
discipline, and then follow the workflow to fix bugs found via V8 diffing, one at a time.

> **This repository is a self-contained checkout extracted from a zip.** All commands work with
> **paths relative to the repository root (where this `CLAUDE_CODE_HANDOFF.md` lives)**.
> They do not depend on absolute paths (such as `/home/claude` or `/tmp`). Below, `$ROOT` refers to the
> root, and shell commands assume you have already `cd`'d to the root.

---

## 0. Setup (always run this first)

Once, at the repository root:

```bash
bash scripts/setup.sh
```

This does all of the following (all repo-relative):
1. `npm install` in `exporter/` (fetches typescript; requires network access to `registry.npmjs.org`)
2. Build the exporter (`tsc` → `exporter/exporter.js`)
3. Build the analyzer (`cargo build --release` → `analyzer/target/release/tsaot`)
4. Precompile the runtime (`gcc -c runtime/ts_rt.c` → `build/rt.o`)

> If `npm install` fails, check that your network configuration allows `registry.npmjs.org`.

> **About macOS**: the scripts are written to **also work on macOS (bash 3.2 / BSD date)**
> (they do not use `mapfile`, `declare -A`, or `date +%s%3N`). They come up with `bash scripts/setup.sh`
> just like on Linux. Only `run_tsc_conformance.sh`, which uses a whole-batch timeout, benefits from
> `gtimeout` (coreutils), but it works without it (it just won't time out). macOS's `gcc` is an alias
> for Apple clang and works as-is. Python 3 is used for `now_ms` millisecond timing (if absent, it
> falls back to perl / gdate / date / second precision, in that order).

Sanity check:
```bash
bash scripts/run_conformance.sh exhaustive | tail -1   # expect: PASS=88 FAIL=0 / 88
```

### Individual builds (rebuild after edits; same as what setup.sh does)
- **After editing the exporter**:
  ```bash
  (cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
     --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)
  ```
  Note: these tsc flags must be exactly as shown (`--skipLibCheck --moduleResolution node --esModuleInterop` are required).
- **After editing the analyzer**: `(cd analyzer && cargo build --release 2>&1 | grep -E "^error")`
- **After editing the runtime**: `gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o` (**rebuild build/rt.o every time**)

---

## 1. Pipeline overview

```
TS source
  → exporter (uses npm's typescript API, exporter.ts)
  → Escape IR JSON
  → Rust analyzer (devirt → escape → SROA → monomorphization → codegen, emit_c.rs)
  → C code (linked with the NaN-boxing runtime ts_rt.c)
  → gcc → native executable
```

**Three things you'll edit:**
- `exporter/exporter.ts` — lowering from TS AST → IR (written in TypeScript)
- `analyzer/src/*.rs` — IR optimization and C generation (mainly `emit_c.rs` `sroa.rs` `devirt.rs` `escape_ir.rs`)
- `runtime/ts_rt.c` / `runtime/ts_rt.h` — C runtime (the implementations of the builtins)

**Compile & run a single file (the basics of debugging; all repo-relative):**
```bash
cd "$ROOT"                                                       # be at the root (make sure to mkdir -p build)
echo 'function main(){console.log([1,2,3].reduce((a,b)=>a*b));}main();' > build/t.ts
node exporter/exporter.js build/t.ts build/t.json build/tl.json  # TS → IR JSON (if UNSUPPORTED appears, the exporter rejected it)
analyzer/target/release/tsaot build/t.json emit > build/t.c      # IR JSON → C
gcc -O2 build/t.c build/rt.o -Iruntime -lm -lcurl -o build/t     # C → executable
./build/t                                                        # run (directly! don't put it in a subshell)
```

When you want to inspect the IR:
```bash
python3 -c "import json;d=json.load(open('build/t.json'));[print(i) for f in d['functions'] for i in f.get('body',[])]"
```

---

## 2. Discipline (mandatory; the bar here is very high)

1. **Never fail silently (loud-reject over silent-miscompile)**. Reject unsupported features explicitly
   with `this.unsupported(node, "reason")`. **The worst outcome is silently producing a wrong result
   (silent miscompile)**. If diffing shows `DIFF` (a wrong value), that is the top priority. `REJECT` is
   second.

2. **Read the code before fixing. Don't write from guesswork**. grep the relevant lowering / codegen /
   runtime and confirm the actual behavior before designing a fix.

3. **Correctness first, but protect hot-path perf**. Don't break the numeric/integer fast paths
   (unboxed double / long long). Even when adding logic such as coercion, preserve both unboxed fast paths.

4. **Be especially careful with high-blast-radius changes (core optimizations like SROA/devirt/escape)**.
   Falling back conservatively (e.g., treating the receiver of a dynamic dispatch as escaping) is
   acceptable as the safe side.

5. **Be honest**. Distinguish and report "implemented", "honestly rejected", and "a separate pre-existing
   bug". Honestly flag bugs that surface even if they are out of scope.

6. **After each fix, always pass full CI before moving on** (procedure in §5). Do not proceed to the next bug before CI passes.

7. **Record docs at each milestone** (§6). If you move on without recording, the work is lost.

---

## 3. The diff harness (the main tool for finding bugs)

`scripts/difftest.sh` compares tsaot's output against node's (which turns TS into JS via typescript and
then evals it). It **works repo-relative**, so just `cd` to the root and `source` it:

```bash
cd "$ROOT"
mkdir -p build
cat > build/r.sh <<'SH'
#!/bin/bash
source scripts/difftest.sh        # auto-detects ROOT, generates build/noderun.js, and defines dt()
dt "test name"  'function main(){ ... }main();'
dt "another"    'function main(){ ... }main();'
SH
bash build/r.sh
```

Notes:
- The shell may be sh, so **don't `source` inline; always go through `bash build/r.sh`**.
- `difftest.sh` assumes `exporter/node_modules`, `exporter/exporter.js`, `analyzer/target/release/tsaot`,
  and `build/rt.o` are all present (if not, run `bash scripts/setup.sh`).
- **After editing the runtime, always rebuild with `gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o`.**
  After editing the exporter, rebuild with tsc; after editing the analyzer, rebuild with cargo (§0).

Verdicts: `OK` = match / `DIFF` = wrong value (fix with top priority) / `REJECT` = unsupported (the exporter explicitly refused).

---

## 4. Workflow (per bug)

1. **Explore**: for a given category (see §7 "exploration candidates"), write 5–15 `dt` cases and run them. Look for `DIFF`/`REJECT`.
2. **Minimize the repro**: reduce the failing case to a single .ts, and by looking at the IR in
   `build/t.json` and the generated code in `build/t.c`, identify **which stage (exporter / analyzer /
   runtime) is the cause**. Don't guess.
3. **Design**: read the relevant code in the culprit stage and devise the minimal correct fix. Check that it doesn't break the hot path.
4. **Implement → rebuild → confirm V8 agreement with `dt`** (including several related cases).
5. **full CI gate** (§5). Don't move on until it's green. If a stale negative test fails, update it
   (bring tests that still reject a now-implemented feature in line with the current state).
6. **Add a conformance test** (§6).
7. **Record docs** (§6).

---

## 5. full CI gate (after each fix, always pass all of it; all repo-relative)

**Recommended: run all gates with a single parallel driver (about 2x faster, ~40s warm).**
```bash
cd "$ROOT"
bash scripts/ci_par.sh        # exit 0 = all green. Builds once → correctness suites in parallel → perf measured alone. Prints a summary.
```

The traditional sequential version (when you want to check them individually):
```bash
cd "$ROOT"
gcc -O2 -c runtime/ts_rt.c -Iruntime -o build/rt.o 2>&1 | grep -i error   # when the runtime was edited
bash scripts/run_conformance.sh basic        | tail -1   # PASS=3 FAIL=0 / 3
bash scripts/run_conformance.sh exhaustive   | tail -1   # PASS=88 (+ your additions) FAIL=0
bash scripts/ci_fast.sh                       | tail -1   # CI-FAST PASSED
bash scripts/run_unit_tests.sh                | tail -1   # [unit] all unit-test suites passed
bash scripts/ci_bench_correct1.sh             | tail -1   # CI-BENCH-CORRECT-1 PASSED
bash scripts/ci_bench_correct2.sh             | tail -1   # CI-BENCH-CORRECT-2 PASSED
bash scripts/ci_bench_perf.sh                 | grep -E "all benchmarks|FAIL"
```

> The CI scripts detect their own root internally and use `exporter/node_modules/.bin/tsc` repo-relative.
> The benchmarks link the runtime, so make sure `build/rt.o` is present.

**perf budget (exceeding it is a regression; the budget is the right-hand number):**
| kernel | target (ms) | budget |
|---|---|---|
| int_kernel | ~382 | 520 |
| float_kernel | ~252 | 480 |
| obj_kernel | ~203 | 290 |
| generic_kernel | ~198 | 260 |
| generic_fn_kernel | ~382 | 520 |
| typed_field_kernel | ~188 | 240 |
| inherit_sroa_kernel | ~81 | 130 |

**Important pitfalls:**
- **CI compares stdout only and ignores the exit code**. Running inside a `$(... 2>&1)` subshell makes
  `$?` misleading. **Run the executable directly to check it** (e.g., `./build/t`).
- nproc=1. The benchmarks take time, so you may wrap them with `timeout 260 bash scripts/ci_bench_perf.sh`.

---

## 6. Recording (per milestone)

1. **Add a conformance test**: place it at `tests/conformance/exhaustive/<category>/<name>.ts`.
   Write the expected value in a comment to the right of each `console.log`. The
   `bash scripts/run_conformance.sh exhaustive` harness automatically compares against node, so an
   increased PASS count is evidence that V8 agreement was achieved.
   Existing categories: arrays, classes, closures, coercion, control, errors, generics, hoisting,
   iteration, maps_sets, numbers, object_methods, objects, operators, private, statics, stdlib,
   strings, symbol, toplevel, and so on.

2. **Record docs**: `docs/conformance_fixes.md` (append numbered entries per session; there are 23 prior
   items) and `docs/TODO.md` (append a one-line summary). Briefly cover cause, fix, verification, and
   perf impact.

> This checkout is an unzipped artifact, so either git commit your work or re-zip the whole directory
> to hand it off (excluding `node_modules`, `target`, and `build` is recommended):
> ```bash
> cd "$(dirname "$ROOT")"
> zip -rq tsaot.zip "$(basename "$ROOT")" \
>   -x '*/exporter/node_modules/*' -x '*/analyzer/target/*' -x '*/build/*' -x '*/.git/*'
> ```

---

## 7. Known bugs you can start on right away, and exploration candidates

### Known bugs (unfixed, quick to fix)
- **optional chaining on an `any` receiver**: `const o:any={f:()=>9}; o.g?.()` aborts with
  "method is not a function" (node returns undefined). `o.f?.()` (the side that exists) is OK.
  For an optional call on an any-typed receiver, it should return undefined when the method is absent.

### Known limitations (not silent miscompiles; low priority, design first if you touch them)
- `-0` representation: the integer unbox path drops the sign of 0 (`Object.is(-0,0)`→true, `console.log(-0)`→0).
  Fixing it would require deopting the integer-zero hot path; cost > benefit.
- `e instanceof Error`: builtin Error is not modeled as a constructor value (loud-reject).
- Multi-level labeled break/continue: multi-level jumps are not modeled (loud-reject).

### Exploration candidates (run `dt` to sweep corners not yet examined)
- Deep dive on async/await (Promise.all, async methods, error propagation, await chaining)
- tagged template literals (currently rejected; `` tag`a${1}b` ``)
- Advanced generators (yield*, generator.return()/throw(), bidirectional yield)
- String-method corners (matchAll, replace with regex, normalize, localeCompare, codePointAt)
- Regular expressions (if unsupported, make a design call: reject or implement)
- Date methods (currently getTime/valueOf only), JSON replacer/reviver/space
- Numeric corners (BigInt, various Number boundaries, all radixes of `toString(radix)`, exponential-notation details)
- Further destructuring corners (nesting + defaults + rest combined, destructuring in function parameters)
- getter/setter inheritance/override, static getter/setter, computed method names
- Spread corners (`f(...a, x, ...b)` in calls, object-spread override order)

Writing about 10 `dt` cases per category and running them is efficient. When `DIFF` appears, go in the order: minimize → identify the stage → fix.

---

## 8. Map of the code (places you'll touch often)

**exporter/exporter.ts:**
- `lowerExpr` — entry point for expression lowering
- `lowerStmt` — statement lowering (for-of goes through the `isForOfStatement` branch, `lowerArrayIndexForOf` helper)
- `lowerAssignTarget` — assignment targets (identifier/property/element/destructuring patterns)
- `lowerFunctionLike` — function bodies and parameters (default arguments, arrowThis cell)
- `lowerClosure` — closure creation (arrowThis capture)
- `builtinReceiverKind` / `namespaceBuiltin` — builtin detection for string/array/map/set/number/Object/Math/JSON, etc.
- the `arrayMethods` / `mapMethods` / `setMethods` allowlists (when adding a method, update both here and emit_c)
- NewExpression branch (Map/Set/Date/Error/user classes)
- loud-reject via `this.unsupported(node, "reason")`

**analyzer/src/:**
- `emit_c.rs` — C generation. The string → C-function mapping for `CallBuiltin`/`CallBuiltinStatic`. BinOp coercion routing. Integer-unbox classification.
- `sroa.rs` — scalar replacement and inlining. `find_sroa_targets` (disqualifies escaping receivers), `captures_this`, `inline_callee`.
- `devirt.rs` — virtual-dispatch resolution (Direct / dynamic Method / Unknown).
- `escape_ir.rs` — IR type definitions (Inst variants, CalleeRef).

**runtime/ts_rt.c / ts_rt.h:**
- The implementations of the builtins (`ts_array_*`, `ts_map_*`, `ts_set_*`, `ts_string_*`, `ts_math_*`,
  `ts_to_*`, `ts_object_is`, `ts_relational`, `ts_loose_eq`, etc.). New functions get an implementation
  in .c and a prototype in .h.

---

## 9. Track record so far (for reference; full details of all 23 items in docs/conformance_fixes.md)

Symbol (3 stages), ToPrimitive, private accessor → number formatting/coercion/parseInt hex →
reduce without initial value, default arguments, arrow-this capture → spread, Map/Set seeding, for-of, array.entries →
destructuring, compound assignment, logical assignment, Object.is → polymorphic virtual dispatch, super, array escape →
Error/subclasses/nested try → Math.cbrt precision, Array.fill range. Currently conformance 88/88, all CI green.

---

The fastest way to get going is to **first run `bash scripts/setup.sh`, then start running `dt` from the
exploration candidates in §7**. After each fix, cycle through §5 → §6.
