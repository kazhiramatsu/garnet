# Runtime execution-performance plan (v1.2, 2026-07-09, s321)

> **v1.2**: Phase 0.1 (flagship profile) was EXECUTED in s321. The results (§1 F12–F15)
> re-rank the phases: **dynamic property access is the #1 cost (~44%), GC root churn #2
> (~15%); string concat does NOT appear in the flagship profile** (it remains #1 only on
> the gc_strings micro). Implementation order is now §5.0. Phases are renumber-free;
> only priorities changed.

Goal: shrink the execution-speed gap between garnet-compiled natives and V8 on the
flagship workload (selfhost native emit: **595 s vs node 35.3 s ≈ 17×**, measured s320/s315)
**without touching the GC reference scheme** (Phase C1 failed in s320; §2 analyzes why and
derives the rules this plan inherits).

This plan is written to be executable by a low-capability agent: every phase is a small,
independently landable, runtime-only change with exact file anchors, invariants, a fixed
verification recipe, and explicit STOP conditions.

## Reading order (START HERE if you are the implementing agent)

1. `docs/TODO.md` — tail only (single source of truth for current state; CLAUDE.md rule).
2. **This document**: §5.0 (what to implement, in which order) → §2 (C1 failure rules
   R1–R6) → §3 (ground rules; the verification recipe §3.4 and GC-discipline rules §3.9
   apply to every change).
3. The section for YOUR work item only:
   - item 1.5 / 1.4 / 1.3 / 1.1 / 1.2 → §5 of this document (self-contained, with code
     sketches and anchors),
   - root batching → **`docs/root_batching_design.md`** (full step-by-step S1–S5),
   - string builder → §6 of this document,
   - shapes+PIC → not yet specified; do not start it from this plan alone (§7.2).
4. `docs/agent_workflow.md` — build / dt / gate mechanics (how to actually run things).
5. Background only if needed: `docs/gc_moving_plan.md` (GC), `docs/refactor_master_plan.md`
   (P-phases), `benchmarks/manifest.tsv` (budgets).

---

## 1. Measured facts this plan is built on

| # | Fact | Evidence |
|---|------|----------|
| F1 | Selfhost native emit = 595 s; node running the same frozen analyzer_ts = 35.3 s | TODO.md s320 / s315 (`bench_selfcompile.sh` stages) |
| F2 | `gc_strings` (a `s += chunk` loop, 150×1500 appends) = **1093 ms wall, 536 MB alloc** — by far the slowest GC bench (others ≤ 180 ms) | `build/bench_history/20260704T061224Z_gc_th2_p2.json` |
| F3 | Profiling `gc_strings`: **`ts_add` is 933 of ~945 non-dyld samples (~99%)** | `build/profiles/gc_strings.sample.txt` (s321) |
| F4 | Each string concat makes **4 full passes** over the output: alloc, copy, `strflags_storage` ASCII rescan, `strhash_units` full FNV hash (`ts_rt.c:2095-2100`). `s += x` in a loop is therefore quadratic **with a 4× constant** | code |
| F5 | The same eager rescan+rehash pattern is repeated at every string-producing site: `ts_rt.c:1442-1443, 1471-1472, 1556-1557, 2154-2155, 3302, 3728-3729, 5076, 5097, 5189-5190` | grep `strflags_storage\|strhash_units` |
| F6 | A lazy-hash accessor pattern already exists and callers already tolerate unhashed strings: `ts_rt.c:3803-3804` (map key hash), `ts_rt.c:1843`, `ts_rt.c:2168` (equality only uses `hash` when both `HASHED`) | code |
| F7 | `class_reg_for` (`ts_rt.c:6256-6269`) does an **O(#classes) linear scan + O(#fields) `need` recomputation on every dynamic property access on a class instance**; `class_field_lookup` adds another O(#fields) scan. Consulted by `ts_get`/`ts_set` (`ts_rt.c:967-968, 1071-1074`) | code |
| F8 | `ts_construct` **mallocs the callargs array on every construction** (`ts_rt.c:6232, 6248`) — the exact pattern P2a-1 removed from `ts_call` (4 M mallocs → 0, gc_closures −16%) | code + TODO s319続き7 |
| F9 | Emit — the flagship's dominant stage — is a string-building workload: frozen `analyzer_ts/src/emitc.ts` builds output with `out.push`/`join` **plus 74 `+=` sites**, incl. per-character `esc += ch` escaping loops (`emitc.ts:32-37, 445-451`) | code |
| F10 | On micro benches, `find_prop` high-probe lookups are startup-only (~207/run); hot loops probe 1–3. Selfhost was **not** measured | TODO s319続き7 (P2a-3) |
| F11 | Manifest gaps where V8 still wins: `gc_churn_kernel` budget 100 vs V8 42, `gc_old_heap_churn_kernel` 160 vs 80, `float_kernel` 480 vs 244, `json_perf_kernel` 80 vs 17 | `benchmarks/manifest.tsv` |

### 1.1 Flagship profile results (Phase 0.1 executed, s321)

Native selfhost (`tsan_typed`, `--profile` build) run on the full 23.4 MB self IR; two 55 s
`sample` windows (t=0–55 s and t=180–235 s; ~46.5k samples each; both windows agree, so the
profile is phase-stable). Top-of-stack shares, mid window:

| # | Cost domain | Functions (samples) | Share |
|---|---|---|---|
| F12 | **Dynamic property access** | `ts_get` 8031 + `ts_set` 7600 + `lookup_prop_chain` 4644 + `ts_get_checked` 381 | **≈ 44%** |
| F13 | **GC root churn** | `ts_gc_root` 5796 + `ts_gc_unroot` 980 | ≈ 15% |
| F14 | Allocator/GC | system malloc/free/memset/realloc + `gc_alloc` + `gc_free_cell_payload` | ≈ 12% |
| F15 | String equality/views | `ts_strict_eq` 2875 + `ts_str_view_typed` 1731 | ≈ 10% |

`ts_add` is **absent** from the flagship top list (frozen emitc builds output via
push/join, F9's `+=` sites are not hot at this scale). `class_reg_for` is separately
visible and negligible (7 samples; only 3 class registrations exist in the generated C).

RT_STATS on a medium slice (125 KB IR, `extends_same_name_scopes.ts`), same binary:
- `find_prop`: 303,025 calls, **avg_probe 3.48**, hist(1,2,4,8,16,32)=
  [147512, 61316, 49083, 43549, 1376, 189] — **85% of lookups probe ≤ 4**. The scans are
  SHORT; the 44% is therefore **call count × per-call fixed overhead**, not scan length.
  A dictionary index (Phase 3.1) would attack the wrong term.
- `root_push` = **4,028,710** on this tiny input — 50× the alloc count (79,948). This is
  deterministic confirmation of F13 (root batching territory).
- `map_find` avg 1.50, `intern` avg 1.12 — the P2a hash indexes are healthy; Map/Set are
  not the problem anymore.

Where the per-access fixed overhead lives (`ts_get`, `ts_rt.c:889-972`): an extern call
(never inlined into generated code), then a **5-step tag ladder** (proxy → string → number
→ bool → func → promise checks) before the plain-object path, then propbag/kind guards, an
array check, `class_field_lookup` (a `class_reg_for` registry scan on every access), and
finally `find_prop`/`lookup_prop_chain`. A JSON-parsed IR object — the analyzer's dominant
data — pays the whole ladder on every `.field`.

Interpretation (v1.2): the **root fix for F12 is AOT shapes + PIC (master plan P6)** —
monomorphic site = shape-id compare + indexed load, inlined at the access site. That is a
multi-session, emit-changing project (own design doc, §7.2). What is implementable NOW,
runtime-only and low-risk, is shaving the fixed overhead (§5 items 1.5 + 1.4) and then the
#2 domain (root batching, §8.1, promoted by F13). The string-builder work (Phase 2,
justified by F2–F5) still fixes a real quadratic and the gc_strings micro, but it is **not**
the flagship lever — it moves to after the property-path work. GC handle indirection (C1)
remains out of scope: even its measured upside (−8…−17% on GC micros) is far below F12+F13.

---

## 2. Why the C1 GC redesign failed (s320) — analysis, and the rules this plan inherits

Understanding this failure is a prerequisite for implementing this plan. Work is parked on
branch `gc-c1-directptr` (commits c24a7e9 prep, b4703c3 flag day, b64a201 span-guard WIP).

### 2.1 What C1 was and how it failed
C1 turned every heap reference from a **handle id** (payload `(slot<<1)|1`, low bit 1,
decoded via a bounds-checked table lookup in `ts_ptr`/`ts_heap_ptr`) into a **direct 48-bit
pointer** (bare mask, no load). Every standard gate was green — conf 341/341, `gate gc`
O2+ASan+runtime, bundler 39/39, selfconf DIFF=0, bench 99/99 — and GC micros improved
(shortlived −15%, cycles −17%, closures −8%). It then **SIGSEGV'd immediately** on the
selfhost milestone (66k instructions, 22 MB IR; pre-C1 completes in 595 s).

### 2.2 Root cause
With direct pointers, the GC decoder cannot distinguish a real heap pointer from a
**non-cell value that merely aliases a heap selector** — e.g. a non-canonical NaN
(`0xFFF9_0004_0000_0000`) or stale garbage: both are aligned, low-bit-0, 48-bit payloads.
Pre-C1, heap refs always had low bit 1, so the two populations were **disjoint by
construction** and garbage decoded safely to NULL. The handle table had been providing
address-space disambiguation *for free*; removing it re-priced that disambiguation, and C1
never paid the price (NaN canonicalization on every path, or a precise cell-region map).

### 2.3 Why every gate missed it
The deref-safety probe in the GC decoder was **ASan-builds-only**. `gate gc`'s ASan stage
therefore passed, and the non-ASan production build only crashes at scale — conformance
inputs are far too small to synthesize aliasing payloads plus a large heap. Scale-dependent
UB has exactly one net in this repo: the milestone-sized real program.

### 2.4 The four "amnesty" bug classes (why this matters to THIS plan)
The flag-day commit had to hand-fix four latent mutator bugs that handle indirection had
been masking: (a) **argument-load-order staleness** (raw values going stale across an
allocation; fixed by rooting at 16 call sites), (b) self-referential cycles from freed-chunk
reuse, (c) **root-after-alloc** dropping writes, (d) class-metadata tables aliasing
CLASS_PROTO roots. Classes (a) and (c) are *ordinary GC-discipline bugs* that any new
runtime code — including the code this plan adds — can introduce today. They are the reason
§3.9 exists.

### 2.5 Failure lesson → rule in this plan
| C1 lesson | Inherited rule |
|---|---|
| A value-encoding change is a global invariant change; it cannot be landed incrementally and its blast radius is the whole runtime | **R1**: Phases 1–2 change **no** tsv encoding, no `ts_ptr`, no handle issuance, no GC phases. Every change is local to named functions, and each is one revertible commit |
| Standard gates all-green ≠ correct; small inputs never exercised the failure | **R2**: the milestone run (§9) is a mandatory acceptance gate, and Phase 2 adds a dedicated **large-input, non-ASan** stress (§6.6) because buffer growth is exactly a scale-dependent behavior |
| ASan-only guards hide production bugs | **R3**: any new fast-path precondition must be either checked in production builds (a cheap branch) or structurally impossible. Debug-only asserts may be added *on top*, never *instead* |
| New runtime code reintroduces GC-discipline bugs (amnesty classes a/c) | **R4**: the coding rules of §3.9 (root across alloc, re-deref after alloc, no raw-pointer caching) are mandatory for every step in this plan |
| The span-guard WIP patched symptoms; the second in-span crash was never root-caused and the branch died unfit | **R5**: STOP means revert-and-analyze. Never ship a guard whose false-positive/negative behavior you cannot state precisely |
| Reverting a flag day costs the whole branch | **R6**: one behavior change per commit; the plan's phases are independently landable and revertible |

Phase 2 (§6) is the anti-C1 by construction: it reuses the existing VIEW machinery and
ordinary string cells, introduces **no new value encoding**, and its one new invariant
(prefix immutability / tail ownership) is local to two functions and deterministically
testable.

---

## 3. Ground rules (apply to EVERY phase)

1. **Runtime-only changes** (Phases 1–2 touch only `runtime/ts_rt.c` + tests): the emitted C
   is unchanged, so **parity (`scripts/emitc_diff.sh`) is unaffected by construction** — still
   run it once per phase to prove it (expect DIFF=0 vs current allowlist).
2. **A/B protocol**: changes confined to `ts_rt.c` (no `ts_rt.h` inline changes) are A/B'd by
   **rt.o swap** on identical generated C: build old/new `rt.o`, then ABAB best-of-9 per
   `scripts/bench_gc.sh` header comments (`TSAOT_RT_OBJ=`). If you must touch a `ts_rt.h`
   inline, the rt.o swap is INVALID (gc_moving_plan.md L203) — full rebuild A/B instead.
3. **Decision counters over wall time**: add/extend `TSAOT_RT_STATS` counters for every
   change; judge by deterministic counters first, wall time second (machine-load lesson,
   CLAUDE.md).
4. **Fixed verification recipe** per landed step (all must be green):
   - `bash scripts/run_conformance.sh` (all, typed) — currently 342/342
   - `bash scripts/ci_fast.sh` and unit tests (`scripts/run_unit_tests.sh`)
   - `bash scripts/gate.sh gc` (O2 + ASan + runtime tests + GC-stress)
   - `bash scripts/run_bundler_tests.sh` — 39/39
   - `bash scripts/run_benchmarks.sh` with budgets (99/99) — zero budget overruns
   - `scripts/emitc_diff.sh` — DIFF=0 (KNOWN unchanged)
   - For string changes: `tests/conformance/exhaustive/strings/` incl. `optimizer_guardrails.ts`
5. **Loud failures only**: never trade correctness for speed; any fast path must fall back to
   the slow path, never approximate (silent-miscompile discipline).
6. **Heavy jobs** (anything ≥ ~2 min wall or the 595 s milestone): agree a time window with
   the user first; run in the foreground with a watchdog (TODO s320 lesson (4)).
7. **STOP conditions** for the implementing agent: any gate red that you cannot explain in
   one sentence; any V8 diff (`dt`) mismatch; any ASan report; any acceptance criterion
   missed by >20%. Stop, revert the offending commit, write findings to the session log.
   Do NOT "fix forward" and do NOT add a guard around a crash you have not root-caused (R5).
8. Before editing, **verify every line anchor cited here** (the file evolves); if an anchor
   drifted, re-locate by identifier name, not by line.
9. **GC-discipline coding rules (R4)** — mandatory wherever your new code can allocate:
   - **Root across alloc**: every heap `tsv` your code still needs after a `gc_alloc`
     (or after calling anything that may allocate) must be under `ts_gc_root` *before* the
     allocation. Balance every root with `ts_gc_unroot` on all exits.
   - **Re-deref after alloc**: raw pointers (`ts_string*`, `ts_object*`, `ts_strview.data`)
     obtained via `ts_ptr`/`ts_str_view_typed` become **stale** at any allocation (minor GC
     moves cells and repoints handles). Re-obtain them after each potential GC point.
     Working exemplar: `ts_add` roots `a,b,sa,sb` and re-derefs both views right after
     allocating the output (`ts_rt.c:2086-2096`) — copy this shape exactly.
   - **Never cache raw pointers across a call** unless you can prove no allocation happens
     in between. When in doubt, re-deref — it is one mask+load.
   - Verify with the GC-stress probe (`scripts/run_gc_stress.sh`, threshold=1 collections)
     — it exists precisely to surface amnesty-class bugs (§2.4).

---

## 4. Phase 0 — profile the flagship (before Phases 3+, parallel-safe with 1–2)

Purpose: replace the "where do the 595 s go?" guess with data. Phases 1–2 are justified by
F2–F9 already; Phases 3–4 are **conditional on this profile**.

### P0.1 Cheap preliminary (no user approval needed, ~5–10 min total)
1. Build the typed selfhost native with symbols:
   `TSAOT_CC="cc -O2 -g -fno-omit-frame-pointer" scripts/typed_selfhost.sh`
   (export + Rust emit ~25 s + cc of ~5.6 MB C, a few minutes; the binary is the
   `tsan_typed2` path printed by the script).
2. Produce the self IR once:
   `node exporter/exporter.js analyzer_ts/src/selfhost_typed.ts /tmp/self.ir.json /tmp/self.l.json`
3. Start the 595 s job but sample only its first ~60 s, then kill it:
   ```
   (ulimit -s 65520; <tsan_typed2> < /tmp/self.ir.json > /dev/null 2>&1) & pid=$!
   sample $pid 60 -file build/profiles/selfhost_native.sample.txt
   kill $pid
   ```
   The native reads IR from stdin and writes C to stdout (see
   `bench_selfcompile.sh:96-99` for the canonical invocation). Early-phase bias is
   acceptable for a first prioritization signal.
4. RT_STATS needs a *completed* run, so use a **medium slice** instead of the full IR:
   `scripts/bench_selfcompile.sh --src <mid-size .ts>` with an `--rt-stats`-built runtime.
   Counters of interest: `concat_calls/concat_bytes`, `find_prop` hist, `map_find` hist,
   `root_push`, `alloc_count/bytes`.

### P0.2 Milestone profile (user-approved time window; ~15 min block)
Full 595 s run under `sample` (`TSAOT_PROFILE_SECS=600` via `scripts/profile_bench.sh`, or
the §P0.1.3 command with `sample $pid 600`) + one full RT_STATS run. Watchdog: poll
`ps -o etime,cpu -p $pid`; kill if CPU goes idle while incomplete (s320 lesson). Record
results in `docs/refactor_baseline.md` and TODO.md.

### P0.3 Decision table — OUTCOME (P0.1 executed s321, see §1.1)
| Profile shows (top-of-stack share) | Action | Fired? |
|---|---|---|
| `ts_add`/`ts_str_concat_many`/`strhash_units`/memcpy from concat ≥ 25% | Phase 2 is the main lever; land 1.1/1.2 first, then 2 | **NO** — `ts_add` absent on flagship |
| `find_prop`/`lookup_prop_chain`/`class_reg_for` ≥ 15% | Property path is the main lever | **YES, 44%** — but hist says short probes ⇒ per-call overhead, so 3.1 (dict) is the wrong tool; do §5 1.5+1.4 now, shapes+PIC (§7.2) as the root fix |
| `ts_gc_root`/`ts_gc_unroot`/root stack traffic ≥ 10% | Promote Phase 4.1 (root batching) from outline to a design doc | **YES, 15%** (root_push 4.03 M / 125 KB input) |
| `gc_*` (collector itself) ≥ 20% | Re-read gc_moving_plan Phase B-3 (byte threshold) / aging; do NOT reopen C1 | NO (~12% incl. system allocator; collector proper is small) |
| None of the above dominates (flat profile) | Escalate to user | NO |

P0.2 (full-run profile + full-run RT_STATS) is still worth one user-approved window before
committing to the shapes design doc, to close the early/mid-window sampling bias.

---

## 5. Phase 1 — contained quick wins (each ≈ ½ session, runtime-only, rt.o-swap A/B-able)

### 5.0 Implementation order (v1.2, set by the §1.1 measurements)

1. **1.5 + 1.4** — attack the #1 domain (44%, F12) at its measured term (per-call fixed
   overhead): fast-path reorder of `ts_get`/`ts_set` + O(1) `class_reg_for`. Runtime-only.
2. **1.3** — construct malloc removal (small, independent).
3. **§8.1 root batching** — the #2 domain (15%, F13; root_push=4 M per 125 KB input).
   Emit-changing ⇒ needs its own short design doc first; start it once 1.5/1.4 land.
4. **§7.2 shapes + PIC design doc** — the root fix for the remaining bulk of F12.
   Precondition: P0.2 milestone profile (one user-approved window).
5. **1.1 + 1.2 + Phase 2 (§6)** — real quadratic fix, now justified by the gc_strings
   micro and general JS workloads, NOT by the flagship. Do when 1–4 are in flight/landed,
   or opportunistically.

Each item: Goal / Steps / Invariants / Verify / Accept / Rollback; one commit each.

### 1.5 `ts_get`/`ts_set` plain-object fast path first (NEW in v1.2 — do this FIRST)
- **Goal**: shave the per-access fixed overhead that §1.1 shows is the actual cost term of
  the 44% domain. Today a plain-object field read runs a 5-step tag ladder + array check +
  class-registry scan before reaching `find_prop` (§1.1).
- **Anchors**: `ts_get` `ts_rt.c:889-972`; `ts_set` `ts_rt.c:1050-1117` (same ladder shape —
  verify before editing); `kind_has_common_header` (grep); `class_field_lookup`
  `ts_rt.c:6271-6278`.
- **Steps**:
  1. At the top of `ts_get` (right after the proxy gate, which must stay first), add the
     dominant-case fast path:
     ```c
     if (TS_TOP16(obj) == TS_SEL_OBJECT) {
       ts_object* o = ts_ptr(obj);
       if (o->h.kind == TS_KIND_OBJECT) {
         if (!g_has_class_regs || !class_field_lookup(o, key, &off, &numeric)) {
           tsv found;
           if (lookup_prop_chain(obj, o, key, &found)) return found;
           return TS_UNDEFINED;
         }
         return struct_field_get(o, off, numeric);
       }
       /* TS_KIND_ARRAY etc. fall through to the existing ladder */
     }
     ```
     `g_has_class_regs` is a new global set at the first `ts_register_class_meta` call —
     a `g_has_proxies`-style single predictable branch: programs with zero class
     registrations (and, after 1.4, all misses) skip the bridge entirely.
  2. The tag ladder below stays byte-for-byte identical — the fast path must be a pure
     shortcut, not a re-implementation. A plain `TS_KIND_OBJECT` receiver must produce
     *identical* results through either path; every other receiver kind falls through to
     the unchanged ladder. (Semantic identity argument: a tsv has exactly one selector, so
     hoisting the OBJECT case cannot change which branch a value takes — only how fast.)
  3. Mirror the same hoist in `ts_set` (verify its ladder order first; the frozen-check /
     accessor / write-barrier logic must remain exactly as-is inside the hoisted path —
     hoist the *dispatch*, never re-order the *semantics*).
  4. Do NOT touch `ts_get_checked` or the METHOD-key paths; they funnel into `ts_get`.
- **Invariant**: pure dispatch shortcut; zero behavioral delta. Any `dt` diff = STOP.
- **Verify**: recipe §3.4 (full), plus `dt` micros: plain-object get/set (own, inherited,
  missing → undefined), string/number/bool method dispatch (`"x".toUpperCase()`,
  `(5).toFixed(1)`), function `.name`/`.length`/`.prototype`, promise `.then` value read,
  array `length`/index/named-prop, class-instance struct fields (typed and `as any`),
  frozen-object write throw, accessor get/set, proxy get/set (`g_has_proxies` path).
- **Accept**: ABAB (rt.o swap; §3.2) on the medium-slice native run (§P0.1.4 input):
  wall ≥ −8%; `sample` of the same shows `ts_get`+`ts_set` share drops materially.
  All benches in budget (the fast path must not regress array-heavy kernels — they enter
  via `TS_KIND_ARRAY` fallthrough, which adds ONE predictable branch; watch
  `int_kernel`/`obj_kernel`/`string_*`).
- **Rollback**: single-commit revert.

### 1.1 Derive concat flags instead of rescanning (`strflags_storage` elision)
- **Goal**: remove one O(n) pass per concat (F4).
- **Anchors**: `ts_add` `ts_rt.c:2072-2107` (scan at 2099); `ts_str_concat_many`
  `ts_rt.c:2108-2162` (scan at 2154); `strflags_storage` `ts_rt.c:1315+`.
- **Steps**:
  1. In `ts_add`'s string branch: the output's `UTF16` bit is already decided pre-copy
     (`flags` at 2093). Replace the `strflags_storage` call with derived bits:
     `ascii = (x.flags & y.flags & TS_STR_FLAG_ASCII)`;
     `out->flags = TS_STR_FLAG_HASHED | flags | ascii;` (keep HASHED and the existing
     `strhash_units` call for now — 1.2 removes them).
  2. Same in `ts_str_concat_many`: AND the ASCII bit across all inputs while looping.
  3. Do NOT modify `strflags_storage` itself — other callers keep it until 1.2 revisits them.
  4. Grep every consumer of `TS_STR_FLAG_ASCII` and confirm the flag is only ever a
     *go-fast license* (fast memchr/case paths), never a *difference witness* (nothing may
     conclude "flags differ ⇒ strings differ"). Record the audited list in the commit message.
- **Invariant**: derived ASCII is conservative (may be 0 for content that is actually ASCII,
  e.g. all-ASCII content stored as UTF16). That loses only speed, never correctness. The
  reverse (ASCII=1 with a ≥0x80 unit) must be impossible: both inputs ASCII ⇒ output ASCII.
- **Verify**: recipe §3.4 + `dt` micros: concat of ASCII×ASCII, ASCII×Latin1, Latin1×UTF16,
  UTF16×UTF16, then run `.toUpperCase()`, `indexOf`, `===` on the results vs node.
- **Accept**: gc_strings ABAB shows measurable win (expect −10…−25%); no bench over budget.
- **Rollback**: single-commit revert.

### 1.2 Lazy string hashing at all producer sites
- **Goal**: remove the second O(n) pass per concat/join/slice-copy (F4/F5); this is master
  plan P2a "hash 遅延化" (expected 1.2–2× on concat-heavy code).
- **Anchors**: producer sites F5; lazy accessor precedent `ts_rt.c:3801-3804`; guarded
  consumers `ts_rt.c:1843, 2168`.
- **Steps**:
  1. Introduce `static uint32_t ts_str_hash_of(tsv s)`: if the cell has `HASHED && !VIEW`,
     return `->hash`; else compute `strhash_view(ts_str_view_typed(s))` and **cache it**
     (`s->hash = h; s->flags |= TS_STR_FLAG_HASHED;`) — but only when
     `!(flags & (TS_STR_FLAG_VIEW | TS_STR_FLAG_STATIC))` (views derive storage from a
     mutable parent; statics are pre-hashed and should never be written).
  2. `grep -n '\->hash' runtime/ts_rt.c` and route every *read* through `ts_str_hash_of`
     or through the existing both-HASHED guards. Known reader sites to audit: `ts_rt.c:1843`
     (map-entry equality fast reject), `2168` (`ts_str_eq` fast reject), `3803-3804` (map
     key hash), plus the view-struct copy inside `ts_str_view_typed` (`ts_rt.h:309+`,
     guarded by HASHED at its consumers). Enumerate all sites in the commit message.
  3. Go lazy ONLY at the concat/derivation sites where the quadratic lives: `ts_add`
     (2100), `ts_str_concat_many` (2155), join (3302), case/trim outputs (5076, 5097,
     5189). **Keep `ts_new_string` (1442-1443) and slice-copy (1556-1557) EAGER**: those
     are one-shot O(n) producers (e.g. every JSON-parsed IR string), and the flagship
     profile shows `ts_strict_eq` at 6% (F15) — parsed strings must keep their hash so
     `===` keeps its hash-based fast reject.
  4. Make `ts_str_eq` (`ts_rt.c:2163+`) call `ts_str_hash_of` (the caching accessor) on
     both non-VIEW operands when lengths match, instead of only consulting pre-set HASHED
     flags: the first compare of a lazily-hashed string is O(n) (same as the memcmp it
     replaces), and every later compare of that cell gets the hash reject back. Without
     this, repeated `===` on lazily-hashed strings would silently regress (F15).
  5. Keep eager hashing where it is free: the small-string singletons
     (`ts_rt.c:1406, 1413`) and static literals (compile-time hashed).
- **Invariant**: `HASHED ⇒ hash is the FNV of the full content`. `hash==0` with HASHED set
  is legal only if the real hash is 0 — preserved because HASHED is only set together with a
  computed value.
- **Verify**: recipe §3.4 + `dt` micros with Map/Set keyed by concat-built strings
  (hit/miss/delete/re-insert), `===`/`!==` on equal-content and differing-tail strings.
  RT_STATS: `intern`/`map_find` probe averages must not regress.
- **Accept**: gc_strings ABAB cumulative (1.1+1.2) ≥ −30%; map/set micro benches neutral.
- **Rollback**: single-commit revert (independent of 1.1 except the two lines in step 3).

### 1.3 `ts_construct` callargs stack buffer
- **Goal**: kill one malloc/free per `new C(...)` (F8), mirroring landed P2a-1.
- **Anchors**: `ts_construct` `ts_rt.c:6209-6255` (mallocs at 6232, 6248); the pattern to
  copy: `TS_CALL_MERGE_STACK` in `ts_call` `ts_rt.c:595-616`.
- **Steps**: replicate the `tsv stackbuf[TS_CALL_MERGE_STACK]`-with-malloc-fallback pattern
  for `nargs+1 <= 16`; the buffer is dead after the call (callee does not retain it — same
  safety argument as P2a-1: GC reachability of args is via the caller's frame, buffer is
  non-scanned in both old and new form). Bonus: today a throwing ctor leaks the malloc'd
  array; the stack buffer cannot leak — note it in the commit message.
- **Verify**: recipe §3.4 + GC-stress probe (`scripts/run_gc_stress.sh`); `dt` micro:
  ctor with 0/1/15/16/17 args (crosses the threshold), ctor that allocates inside, ctor that
  throws.
- **Accept**: new RT_STATS counter `construct_malloc` (analogous to `call_env_malloc`)
  drops to 0 on an allocation-heavy fixture; `gc_churn_kernel`/`obj_kernel` neutral-or-better.
- **Rollback**: single-commit revert.

### 1.4 `class_reg_for`: precomputed size + hash index
- **Goal**: O(#classes)+O(#fields) per dynamic class-instance property access → O(1) (F7).
- **Anchors**: `class_reg_for` `ts_rt.c:6256-6269`; registration `ts_register_class_meta`
  (grep for it); the pattern to copy: append-only open-addressing index from P2a-2
  (`field_index_lookup/put/reserve`, `ts_rt.c:5286-5305`).
- **Steps**:
  1. At registration time, precompute the `need` value (max field end offset) and store it
     in `ts_class_reg` (new field `size_t min_size`); delete the per-call recompute loop.
  2. Add an open-addressing u32 index: key = proto handle payload
     (`(uint32_t)(r->proto & TS_PAYLOAD_MASK)` mixed with the fibonacci constant, as in
     `ts_rt.c:3809`), value = reg slot+1, pow2 capacity, load < 3/4, reserve-then-put on
     registration (mirror `field_index_reserve`'s re-insertion order caveat). The registry
     is append-only — verify by grepping writes to `g_class_regs`/`g_class_reg_len`; no
     deletions ⇒ no tombstones, exactly like the field-intern index.
  3. `class_reg_for` = one hash probe + the existing `h.size >= min_size` check. Delete the
     linear scan (the index is total).
  4. Leave `class_field_lookup`'s inner per-field scan alone (nfields is small); if selfhost
     RT_STATS later shows avg > 4 probes, index it in a follow-up commit, not now.
- **Invariant**: proto handle values are stable under the current handle GC (moving repoints
  the table; ids never change). Leave a comment that a future C1 must revisit this index.
  Note `proto_rewrite` semantics are unchanged: a rewritten instance proto misses the index
  and returns NULL — identical to today's linear-scan miss.
- **Verify**: recipe §3.4 + `dt` micros: dynamic access (`(o as any).x`) on class instances
  incl. inherited fields, subclass instances, `Object.keys` of instances; run the
  `dynamic_dispatch`, `dynamic_inherited`, `proto_rewrite` benches explicitly.
- **Accept**: deterministic — new RT_STATS `class_reg_probes`; avg ≤ 2.
- **Rollback**: single-commit revert.

---

## 6. Phase 2 — extendable string buffers (the quadratic-append fix; ~1–2 sessions)

> **Priority note (v1.2)**: the flagship profile (§1.1) shows `ts_add` is NOT hot on
> selfhost — this phase's justification is the gc_strings micro (F2–F3: 99% in `ts_add`,
> a real O(n²)) and any user program with `s += x` loops, not the 595 s target. Slot it
> per §5.0 (after the property-path and root-batching work), not first.

### 6.1 Problem and shape of the fix
`s += x` in a loop is O(n²) copy+hash today (F2–F4). V8 solves this with cons strings
(ropes); the master plan **explicitly rejects ropes** (readers must stay contiguous for the
view/RegExp substrate). The alternative with the same asymptotics and contiguous reads is
the classic **extensible string buffer** (SpiderMonkey "extensible strings"): let the most
recent concat result own slack capacity in a hidden buffer cell; appending to it is a
memcpy of the suffix only; every intermediate value stays a valid immutable string because
it is a VIEW of a stable prefix `[0, len)` of that buffer — appends only write at
`[used, used+k)`, never mutating any prefix a live string can see.

All infrastructure already exists: VIEW strings with `parent`/`offset`
(`ts_rt.h:227, 232-238`), the recursive view resolver `ts_str_view_typed` (`ts_rt.h:309+`),
GC marking of `parent` (`ts_rt.c:2410`), and lazy hash after 1.2. No tsv encoding, no GC
phase, and no emitted-C change is involved (rule R1).

### 6.2 Data model
- New internal flag: `TS_STR_FLAG_BUFFER = 1u << 5` (in the `enum` at `ts_rt.h:224-230`).
- A **buffer cell** is a `ts_string` with `BUFFER` set, never exposed as a JS value; it is
  reachable only via the `parent` field of view results. Its fields:
  - `len` = **high-water mark** in code units (units written so far),
  - capacity derived from the GC header: `cap_units = (h.size - sizeof(ts_string)) / width - 1`
    (the −1 keeps the NUL convention; verify the exact slack against `ts_string_alloc_storage`
    `ts_rt.c:1323+` before coding),
  - storage width (`UTF16` bit) **fixed at creation, never promoted in place** (promoting
    would re-layout bytes under existing views' offsets → memory corruption; width mismatch
    always takes the copy path),
  - `hash = 0`, never HASHED; ASCII bit maintained incrementally (cleared as soon as a
    non-ASCII append lands).
- A **built string** (what `ts_add` returns) is a VIEW: `parent = buffer, offset = 0,
  len = old_used + appended`. Reads go through `ts_str_view_typed` exactly like slice views
  do today (one extra indirection, no flattening ever needed since storage is contiguous).

### 6.3 The append rule (all inside `ts_add`'s string branch)
```
lhs extendable?  :=  lhs is VIEW && lhs->offset == 0
                  && parent has TS_STR_FLAG_BUFFER
                  && lhs->len == parent->len            /* lhs owns the tail */
                  && widths match (rhs representable in parent width)
                  && parent->len + rhs.len <= cap_units(parent)
yes → EXTEND: memcpy rhs units to parent->data + parent->len*width;
      parent->len += rhs.len; clear parent ASCII if rhs not ASCII;
      return new VIEW(parent, 0, parent->len)
no, but result n >= TS_SB_MIN (start with 24; tune by A/B)
    → FRESH: allocate a buffer cell with cap = pow2 ceil(max(2*n, 32));
      copy lhs then rhs into it (this re-flattens a non-owning lhs once);
      buffer->len = n; return new VIEW(buffer, 0, n)
no, n < TS_SB_MIN → FLAT: existing flat-copy path unchanged
```
Key property: a *linear* append history hits EXTEND every time (amortized O(1) via pow2
growth); a *branched* history (two different strings extending the same prefix) is safe —
the second branch fails `lhs->len == parent->len` and takes FRESH.
Overflow guard (production build, R3): if `n` would exceed `UINT32_MAX/2` code units, take
FLAT (which shares today's length limits) — never wrap the pow2 computation.

### 6.4 Correctness obligations (each becomes a test)
1. **Prefix immutability**: no code path may write `parent->data[0 .. any live view's len)`.
   The only writer is EXTEND, which writes at `[parent->len, …)` and only when the extender's
   `len == parent->len`.
2. **Buffer never escapes**: the buffer tsv is stored ONLY into `->parent` fields. Debug
   builds add `assert(!(flags & TS_STR_FLAG_BUFFER))` where strings are handed to user code;
   production correctness must not depend on the assert (R3) — it doesn't, by construction,
   as long as step 6.5 code returns only the VIEW.
3. **GC**: buffer cells are ordinary `TS_KIND_STRING` cells; `parent` marking already exists
   (`ts_rt.c:2410`); big buffers automatically take the calloc (non-nursery) path — no GC
   changes at all.
4. **Views of views**: user slices of built strings create depth-2 chains
   (slice → view → buffer). `ts_str_view_typed` already recurses; confirm
   `ts_string_slice_view` (declared `ts_rt.c:249`) behaves with a VIEW src (it does today
   for slice-of-slice).
5. **Flag semantics under mutation**: `ts_str_view_typed` re-derives a view's storage bits
   from the *parent's current* flags — clearing the buffer's ASCII bit makes older
   all-ASCII views report non-ASCII. That is the safe direction (loses a fast path only).
   Rely on the 1.1 step-4 audit that ASCII is never a difference witness.
6. **Hash/equality**: built strings are views ⇒ never HASHED ⇒ all consumers take the
   compute-on-demand path introduced in 1.2 (1.2 is therefore a prerequisite). Views cache
   no hash today; keep it that way (prefix-stability would allow caching, but simplicity
   wins until RT_STATS says otherwise).

### 6.5 Implementation steps (in order, one commit each)

GC-discipline preface (R4, §3.9): both new arms allocate, so raw pointers go stale
mid-function. The exact orderings below are load-bearing — do not reorder.

- **EXTEND arm ordering**: ① under the existing roots (`sa`,`sb` are already rooted in
  `ts_add`), read `parent_tsv = lhs->parent` and root it; ② read lengths and decide
  extendability; ③ allocate the result VIEW cell **first** (if a GC runs here, parent is
  still consistent — its `len` is unchanged); ④ **re-deref** `parent_tsv` and `sb` to fresh
  raw pointers/views (pattern: `ts_rt.c:2096`); ⑤ memcpy the rhs, bump `parent->len`, update
  parent ASCII; ⑥ fill the view fields (`parent = parent_tsv`, offset 0, new len); ⑦ unroot.
  Never touch the pre-③ raw pointers after ③.
- **FRESH arm ordering**: ① allocate the buffer cell; ② wrap it in a tsv and
  `ts_gc_root` it (a raw `ts_string*` local is NOT a root — this is amnesty class (c),
  §2.4); ③ allocate the view cell; ④ re-deref the buffer and both input views; ⑤ copy
  lhs then rhs into the buffer, set `buffer->len`; ⑥ fill view fields; ⑦ unroot.

1. Add the flag + `cap_units` helper + RT_STATS counters `sb_extend`, `sb_fresh`, `sb_flat`
   (the three §6.3 outcomes). Dead code so far — verify recipe §3.4 stays green.
2. Implement FRESH only (every big concat allocates buffer + view; no EXTEND yet). This
   changes allocation shape but not asymptotics — it exists to soak the new cell kind
   through every gate before in-place mutation enters. Full recipe §3.4 + new conformance
   fixture `strings/concat_growth.ts`: linear `+=` loop (ASCII), loop with Latin1/UTF16
   promotion mid-stream, **branched history** (`a = s + "x"; b = s + "y"` — assert both),
   slices of built strings, built strings as Map keys and `===` operands, `charCodeAt` /
   `indexOf` / `slice` / `toUpperCase` over built strings — all `dt`-verified vs node.
3. Enable EXTEND. Re-run everything in step 2 plus `scripts/run_gc_stress.sh` and
   `scripts/gate.sh gc` (ASan). ABAB `bench_gc.sh gc_strings`.
4. Wire `ts_str_concat_many` (`ts_rt.c:2108`): treat `args[0]` by the same extendable test;
   remaining args append in one reserve. Same ordering rules.
5. Sweep the remaining O(n²) producers only if RT_STATS says they matter (template-literal
   join; `Array.prototype.join` already precomputes total length — verify, don't rewrite).
6. **Scale stress (R2/R3, addresses §2.3 directly)**: a non-ASan `cc -O2` build must run a
   dedicated large-input stress — build a ≥64 MB string via a `+=` loop (with periodic
   branched histories and slices), verify a content checksum vs node, plus the same fixture
   under `gate gc` (ASan + threshold=1). Small conformance inputs alone would repeat the C1
   gate blind spot: buffer growth/ownership is exactly a behavior that only misbehaves at scale.
7. Tune `TS_SB_MIN` and the growth factor by ABAB on gc_strings + the string kernel suite
   (all 32 `string_*` rows must stay in budget — they exercise the view/metric fast paths
   that must not regress).
- **Accept**: `gc_strings` ≥ 5× (1093 ms → ≤ 200 ms; alloc_bytes 536 MB → ≤ 60 MB);
  `string_*` 32/32 in budget; conformance/gate/parity per recipe; step-6 stress green in
  BOTH build flavors. Then ratchet the gc_strings baseline (and any covering manifest budget).
- **Rollback**: EXTEND is one commit (step 3) — reverting it leaves a correct (slower)
  FRESH-only path; reverting steps 1–2 restores today's exact behavior.
- **STOP**: any ASan/GC-stress/scale-stress hit ⇒ revert the offending commit, record, and
  analyze offline (R5). No guard-patching an un-root-caused crash — that is how the C1
  branch died (§2.4).

### 6.6 Expected effect on the flagship
`esc += ch` per-character loops (F9) become O(L); every `s += part` line-builder in emit
becomes amortized O(1) per append. Whether this moves 595 s by 2× or by 20% is exactly what
Phase 0's profile decides — do not claim a number before P0.2.

---

## 7. Phase 3 — property lookup (CONDITIONAL on Phase 0)

Trigger: P0 profile shows `find_prop`/`lookup_prop_chain`/`class_reg_for` ≥ 15% of samples,
or selfhost RT_STATS `find_prop` histogram shows steady-state (not startup) mass at ≥ 8
probes.

> **v1.2 measurement note**: the trigger fired (44%) **but the hist did not** — flagship
> probe lengths are short (avg 3.48, 85% ≤ 4; §1.1). 3.1's dictionary attacks scan length,
> which is NOT the measured cost term, so 3.1 stays DORMANT unless a future workload shows
> a long-probe histogram. The property-path work that IS justified now: §5 1.5 + 1.4
> (fixed overhead), then §7.2 shapes+PIC (the root fix).

3.1 **Per-object dictionary index** for objects with `len > 8` props: open-addressing
`u32 key→slot` sidecar allocated lazily, invalidated on `ts_delete_prop`'s compaction
(delete does an array down-shift → simplest correct policy: free the sidecar on any delete;
rebuild lazily). Costs and the reasons this was deferred are recorded in TODO s319続き7
(P2a-3): +1 word in `ts_obj_common` (use the padding after `shape` — verify struct size
before/after with a static assert), a hot-path branch, and delete-invalidation. Implement
only with the trigger evidence, as a single commit, with RT_STATS before/after histograms
in the commit message.

3.2 **AOT shapes + PIC** (master plan P6) is *not* specified here — it changes emitted C,
IR, and the exporter, and needs its own design doc with a parity-allowlist strategy and a
milestone acceptance gate (selfhost completion + output identity, per §2.5 R2). Entry
condition: Phases 1–2 landed, P0.2 milestone profile exists, and the user approves the
scope. The `ts_object.shape` word is currently overloaded with freeze/seal bits
(`ts_rt.c:860-888`) — any shapes design must first relocate those three bits (e.g. into
`ts_gc_header` spare bits) as its own preparatory, behavior-invariant commit.

---

## 8. Phase 4 — outlines (need P0 evidence + their own design docs)

- **4.1 Root batching — PROMOTED (v1.2)**: evidence in hand — 15% of flagship samples in
  root/unroot (F13), deterministic `root_push` = 4.03 M on a 125 KB input (§1.1). Two
  candidate designs, both replacing per-value registration with per-scope (or zero) cost
  (user discussion s321; cf. mruby's `mrb_gc_arena_save/restore`):
  - **Design A — shadow-frame batching** (master plan P6 original): group reflike locals
    into one contiguous struct; prologue pushes ONE `{base, count}` frame, epilogue pops.
    ~8–10× fewer root-stack ops. Keeps precision, and precise local enumeration is the
    missing substrate any future moving/direct-pointer GC (C1 retry) needs. No new
    optimizer pessimization: locals are already address-taken via `ts_gc_root(&l)`.
  - **Design B — conservative handle-scan — REJECTED as primary (s321 user review)**:
    delete root registration entirely; at GC, scan the used C stack + a setjmp-spilled
    register file for handle-patterned tsvs (`top16 ∈ 0xFFF8..0xFFFD`, payload low-bit 1,
    `id < handle_len`, table-validated). Mutator cost → 0 and the C1 amnesty classes
    (a)/(c) would disappear — but conservative scanning has TWO failure directions and
    the second one kills it:
    1. *False positives* → retention. Handle validation bounds the damage to over-retaining
       live table entries (never touching freed memory), but with the 64 MB selfhost stack
       and deep recursion the ambiguous-word population is large; in long-running programs
       this accumulates as an effective leak (the documented MRI/Boehm pain; CRuby still
       conservatively marks the machine stack and pays this cost + RB_GC_GUARD;
       SpiderMonkey and Mono abandoned conservative scanning for exactly these reasons).
    2. *False negatives via C optimization* (the killer): at -O2 the compiler dead-stores a
       tsv local after its last read while a DERIVED raw pointer (`ts_string*`,
       `view.data`) is still in use — the scan finds neither, the cell is collected,
       premature free. This is CRuby's `RB_GC_GUARD` class: crash-direction, compiler- and
       scale-dependent, invisible to small-input gates — the same failure signature as C1
       (violates R3/R5). Making B safe requires forcing every reflike local into
       enumerable memory — which IS Design A. B's safe form degenerates into A.
    Recorded here as a rejected alternative with rationale; do not revisit without a
    design that eliminates failure direction 2 outright.
  - **Why mruby's arena cannot be adopted verbatim**: mruby's Ruby-level locals are rooted
    by the scanned VM stack, and its GC is non-moving; the arena only covers C-extension
    fresh allocations. garnet has no scanned VM stack — ALL locals are C locals — so an
    allocations-only arena leaves the only-reference cases unprotected
    (`const x = arr.pop()` / `x = obj.f; obj.f = null` then alloc → x dangles). An
    arena-style "auto-protect fresh allocations" remains useful as a COMPLEMENT to A for
    runtime-internal result rooting; B subsumes it entirely.
  - **Shared blocker**: both change every emitted prologue ⇒ parity DIFF on all fixtures.
    Options: land after P4 (parity graduation) or add a mechanical prologue normalizer to
    `emitc_diff.sh`. Decide in the design doc.
  - **Decision (s321)**: **Design A (shadow-frame batching) is the primary design.** It
    has neither failure direction (locals stay precisely enumerable and memory-resident —
    the same constraint `ts_gc_root(&l)` already imposes today), adds no compiler- or
    scale-dependent hazard class, and builds the local-enumeration substrate a future C1
    retry requires. Runtime-internal operand rooting (ts_add etc.) stays explicit as
    today; if the counter split shows runtime-internal origins are significant, consider
    mruby-style auto-protection of fresh allocation results as a COMPLEMENT to A there.
  - **Full implementation spec: `docs/root_batching_design.md`** (s321) — exact structs
    (`ts_frame_hdr`, inline push/pop), runtime anchors (GC walks ts_rt.c:2711/2810,
    exception snapshot 8836/8847 + landings 9126/9423), emitter anchors (the three
    function emitters, `Ctx.nroot`, the 22 unroot sites, the 69 `v{}` format sites), v1
    scope exclusions (coro/GLOBALS/ss_base/_cv), and the 5-step commit plan
    S1 runtime substrate → S2 vname centralization (parity-locked, byte-proof) →
    S3 `TSAOT_FRAME_ROOTS` flag (default OFF = parity green) → S4 flag-ON battery + A/B
    (doubles as the root_push counter split) → S5 default flip (parity event, user
    sign-off required).
- **4.2 Arity-specialized direct-call ABI / closure ABI** (master plan P6): emit-side;
  same gating as 4.1.
- **4.3 GC B-3** (byte-based young threshold, gc_moving_plan Phase B remainder): small,
  runtime-only, but only worth doing with P0 evidence that collection frequency (not
  mutator work) matters on the flagship.

---

## 9. Milestone acceptance (end of Phases 1+2)

With a user-agreed time window: re-run the selfhost milestone
(`bench_selfcompile.sh --native <tsan_typed2>`, watchdog per §3.6):
1. Native emit completes; its output is **byte-identical to the emit-node output**
   (`cmp native.c node.c` — the frozen analyzer_ts on node is the oracle, so no pre-change
   595 s baseline capture is needed; `bench_selfcompile.sh` already computes rust↔node parity).
2. Wall time vs the 595 s baseline recorded in TODO.md + `docs/refactor_baseline.md`.
3. Full gate: `scripts/gate.sh` all + conformance all + bundler + selfconf + bench 99/99.

This gate exists because of §2.3: standard gates alone are structurally unable to catch
scale-dependent bugs. Phases 1–2 may NOT be declared complete without it.

---

## 10. Explicit non-goals

- **GC C1 (direct pointers / handle removal)**: failed s320, reverted; work parked on branch
  `gc-c1-directptr`; full post-mortem in §2. Re-entry requires the s320 preconditions
  (selector-aliasing eradication design, milestone-grade acceptance, non-ASan large-input
  stress) — none of which this plan attempts. Nothing in Phases 1–2 changes `tsv` encoding,
  `ts_ptr`, or handle issuance.
- **Rust analyzer compile speed** (P2b, 23.7 s → ≤5 s): different program, different plan.
- bigint, Array.prototype monkey-patching (CLAUDE.md known-deferred list).
- Ropes (rejected in the string plan; §6 is the contiguous alternative).
