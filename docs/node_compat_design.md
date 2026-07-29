# Node.js compatibility — phased design (v1.2, 2026-07-09, s322)

v1.2 (same session, user direction): V8 C++ API compatibility is now IN scope as Phase
N8b (§12), based on a survey of Bun's implementation (class inventory from
`oven-sh/bun` `src/jsc/bindings/v8/`, tracking issue #4290, and the two "How Bun
supports V8 APIs without using V8" blog posts). §1.3 updated (V8-API row moved out of
"Never"); §13/§14 renumbered from §12/§13. IMPORTANT correction recorded in §12.1: the
shim layer itself must be C++ (mangled symbols + inlined header code in addon
binaries) — ts_rt staying C is compatible with that, but does not make the work easier.

v1.1 (same session, self-review): fixed the oracle-comparison claim (harness diffs
stdout+stderr combined, not stdout — §2 R-E, §5.1, §5.6), fixed the setTimeout
unbox-flag inconsistency (§5.4/§5.5), added the libuv readdir sort requirement (§7.2),
added reachability guards for `globalThis.*`/value-position builtins (§5.7, §6.5),
added §1.5 known-gaps register (setImmediate, import.meta.url, URL, TextEncoder,
unhandled rejections, exit codes), plus smaller GC/UB notes. Verified as fine during
review: parameter properties (exporter.ts:9765), rest/spread lowering (:203, :1022),
Map/splice/indexOf builtin arms, sequential oracle/native runs in the harness.

Goal: compile programs that use Node.js APIs (`setTimeout`, `process`, `node:fs`, `node:path`,
eventually npm packages) with garnet, keeping node (= V8) as the diff oracle. This document
turns the "6 pillars" discussion into an implementable, phased plan.

**This document is written to be implemented step-by-step by a low-capability agent.**
Every early phase (N1–N3) names exact files, functions, and line anchors — verify each anchor
before editing; if drifted, re-locate by identifier, not line number. Later phases (N4–N7)
are specified at interface-contract level and each requires its own short design doc before
implementation (same rule as shapes+PIC in `docs/runtime_perf_plan.md`). Do phases in order;
inside a phase, do steps in order; one step = one commit.

Status: design only — no code exists yet. Nothing here is started until the user schedules it.

## 0. Read first, in this order

1. `docs/TODO.md` — tail only (current repo state; CLAUDE.md rule).
2. `CLAUDE.md` — Discipline section (loud reject, zero perf regression, gates) and the
   cross-cutting lessons (GC rooting, METHOD/FIELD key namespace).
3. This document: §1–§4 always; then ONLY the section for the phase you are implementing.
4. `docs/agent_workflow.md` — build / `dt` / gate mechanics.
5. For N1 specifically: `docs/async_design.md` (the existing loop you are extending).

## 1. Goal, non-goals, success metric

### 1.1 Goal (what "Node compat" means here)

A **curated, growing subset** of Node.js, correct-by-oracle: every supported construct
produces byte-identical stdout to `node` running the same source. Unsupported constructs are
**loud** (compile-time `unsupported(...)` or a catchable runtime throw with a message naming
this document). We do NOT aim for full Node compatibility; we aim for "this documented subset
is trustworthy".

### 1.2 Milestones (the scorecard)

- **M1 "hello node"** (end of N3): timers + `process` + `node:fs` (sync/utf8) + `node:path` +
  `node:os` + `node:util` + `node:events` conformance suites green.
- **M2 "first real package"** (end of N5): one zero-dependency, pure-ESM npm package from
  `node_modules/` compiles and its output matches node.
- **M3 "CJS"** (end of N6): one zero-dependency CommonJS package works via static `require`.
- **M4+** (N7, unscheduled): Buffer/TypedArray, streams, async I/O (libuv), `node:http`.
- **M5 "native addon"** (N8, unscheduled): one `.node` addon loads and passes its tests —
  first an N-API addon (N8a), later a nan/V8-API addon (N8b, §12).

### 1.3 Non-goals (permanent or indefinitely deferred)

| Item | Status | Reason |
|---|---|---|
| `eval` / `new Function` / `node:vm` | **Never** | Fundamentally incompatible with AOT. Loud compile error. |
| V8 C++ API addons | **Phase N8b (§12)** — in scope per user direction (s322), scoped to Bun's proven subset | The full V8 embedder API stays out of scope forever; N8b is an ABI façade for the subset real addons use. |
| N-API (`.node` addons) | **Phase N8a (§12)** | Engine-agnostic C ABI; the sane first step of native-addon support and a prerequisite investment for N8b (shared dlopen/module-registration/Buffer plumbing). |
| `worker_threads` / cluster | Deferred | Runtime is single-threaded by design (see `docs/fetch_https_design.md`). |
| Dynamic `require(expr)` / dynamic `import(expr)` | **Never** (non-literal) | Unresolvable at compile time. Loud reject. String-literal `import()` may later lower to a resolved thenable. |
| `Array.prototype` monkey-patching | Already outside the model (CLAUDE.md) | — |
| bigint-dependent APIs (`fs.stat({bigint:true})`, `crypto`) | Blocked on bigint (unsupported) | — |
| Windows (`path.win32`, drive letters) | Deferred | posix-only v1. |

### 1.4 Documented divergence register

Divergences are only acceptable if listed here AND impossible to hit silently in a way that
changes computed values (printing/inspecting is the observable difference, not data flow).
Conformance tests must not observe these.

| # | Divergence | garnet | node |
|---|---|---|---|
| D1 | `setTimeout` return handle | number (timer id) | `Timeout` object (`typeof` = "object"; coerces to id via `Symbol.toPrimitive`) |
| D2 | `process.argv[0]/[1]` contents | both = native binary path | node path / script path (tests must use `.slice(2)`) |
| D3 | Writing `process.env.X` | updates the JS object only | also calls `setenv` |
| D4 | fs error `.message` wording | best-effort match of libuv wording | libuv wording (`.code` is the contract; tests compare `.code`) |
| D5 | `timer.ref()/unref()/refresh()` | absent (runtime TypeError if called) | present |
| D6 | uncaught exception exit path | `abort()` after "tsaot: Uncaught exception: …" (ts_rt.c:8859) | prints stack, `exit(1)` — conformance tests must therefore never terminate via an uncaught throw (§2 R-E) |

### 1.5 Known gaps — deliberately absent from the phase plan (tracked so they are not forgotten)

| Gap | Why deferred / plan hook |
|---|---|
| **Unhandled promise rejection** | garnet today drops a waiter-less rejected promise SILENTLY (verified: no tracking in ts_rt.c); node prints the reason and exits 1. This is observable silent divergence for node programs. Fix belongs with N2 (process/exit semantics): minimal design = track rejected-and-never-awaited promises, report + `exit(1)` at loop exit. Needs a decision in the N2 session. |
| Uncaught-exception exit code | D6: `abort()` (SIGABRT) vs node `exit(1)`. Changing the existing runtime path is user-visible beyond node-compat — needs an explicit user decision (proposal: `fflush; exit(1)` when node-compat is active). |
| `setImmediate` / `clearImmediate` | Not in the DOM lib ⇒ already a NATURAL loud compile error today (no silent risk). Deferred because its ordering vs `setTimeout(0)` at top level is nondeterministic even in node (untestable via oracle); revisit with the libuv phase (check-phase semantics). |
| `import.meta.url` (and ESM `__dirname` idioms) | Used by real packages. AOT answer: bake the compile-time `file://` URL of the source module in as a constant. Assign to the N4 design doc (it is a bundling concern). |
| `URL` / `URLSearchParams` | Pure-TS shim candidate (no host deps) once needed by a scorecard package; not scheduled. |
| `TextEncoder` / `TextDecoder` | Blocked on TypedArray (N7 table). |
| `node:timers/promises` | Trivial TS shim over `setTimeout` + `new Promise` — easy follow-up after N3; note the shim map keys on the FULL subpath (`"timers/promises"`). |
| `node:process` / `node:timers` module forms | `import process from "node:process"` etc. — thin re-export shims, easy after N2/N3. |
| `crypto.randomUUID()` | Ubiquitous and Buffer-free; a one-primitive candidate (`arc4random_buf` + format). Unscheduled. |
| `typeof Buffer !== "undefined"` guard pattern | Common in dual-env JS. In TS input it's a compile error (loud). The N5 design doc must decide what untyped-JS mode does with unresolved globals under `typeof`. |

## 2. Ground rules (apply to every phase)

- **R-A Loud reject.** Any Node API outside the implemented subset must fail at compile time
  via `this.unsupported(node, "... (node-compat: see docs/node_compat_design.md §X)")` or at
  runtime via `ts_throw` of an Error object. Silently returning `undefined` is forbidden.
- **R-B Single-branch gating.** New runtime state must not add cost to programs that don't use
  it. The only shared-path edits in this plan are the event-loop body (§5.6) and the
  nextTick-aware drain (§6.6); both are cold/loop-control code, but each still requires a
  flagship A/B bench (accept: Δ within noise) before merge.
- **R-C GC discipline.** Every new runtime function that allocates roots its live tsv
  arguments (`ts_gc_root`/`ts_gc_unroot`, ts_rt.c:361/369); every new global tsv container
  gets mark hooks in BOTH `gc_mark_async_roots` (ts_rt.c:9535) and
  `gc_mark_async_roots_young` (ts_rt.c:9541) — the abort timers show the exact pattern
  (ts_rt.c:9806-9812). Run the GC-stress probe (`scripts/run_gc_stress.sh`) for every phase.
- **R-D No new IR instructions in N1–N3.** Everything lowers through the existing
  `CallBuiltinStatic { builtin: "<ns>.<name>" }` channel (exporter → emit_c string match).
  This avoids the IR-struct trap (CLAUDE.md: new IR fields force edits in sroa.rs + 4 test
  literal files) entirely. If a later phase truly needs an IR change, that phase's design doc
  must call it out.
- **R-E Oracle = node.** All conformance tests live under `tests/conformance/basic/node/`
  and run through the unchanged harness (`scripts/run_conformance.sh`): node executes the
  same source natively, so node IS the Node-compat oracle for free. Tests must be
  deterministic (no wall-clock-dependent output, no divergences from §1.4).
  **The harness diffs stdout AND stderr combined** (`2>&1` on both runs,
  run_conformance.sh:86/101) — so a test may `console.error` (wording matches), but it must
  NEVER terminate via an uncaught throw or unhandled rejection (garnet's and node's crash
  banners differ, D6/§1.5); every intentional error must be caught and printed by the test.
  The harness runs oracle and native sequentially per test (verified), so fs tests reusing
  one tmp path are race-free as long as each cleans up in `finally`.
- **R-F analyzer_ts stays frozen.** No node-compat porting into `analyzer_ts/` ever
  (CLAUDE.md §315 rule). All work: `exporter/`, `analyzer/src/emit_c.rs`, `runtime/ts_rt.c`,
  plus new TS shims under `exporter/node_shims/`.
- **R-G English** for all code, comments, docs, commit messages.

## 3. Existing seams (verified 2026-07-09; re-verify anchors before editing)

| Seam | Where | Role in this plan |
|---|---|---|
| Event loop | `ts_run_event_loop` ts_rt.c:9498-9508 | N1 extends its body |
| Microtask queue (coros only) | `g_microq`/`microq_push_v` ts_rt.c:8946-8952; `drain_microtasks` :9489 | N1 `queueMicrotask` rides it via an adapter coro |
| Adapter-coro precedent | `ts_adopt` + `adopt_resume` ts_rt.c:8992-9007 (alloc pattern just below) | template for callback→coro adapters |
| I/O task queue | `ts_io` ts_rt.c:9440-9482 | untouched until N7 (libuv migration) |
| Timer precedent | abort timers ts_rt.c:9693-9812 (`ts_now_ms_raw` :9700, `..._fire_due` :9773, `..._poll_timeout_ms` :9789, GC marks :9806) | N1 copies this shape for general timers |
| Call a JS value from C | `ts_call_value(fn, args, nargs)` ts_rt.h:823 | timer/tick/microtask firing |
| Host-builtin plumbing (3 layers) | exporter arm exporter.ts:3811-3817 (`__read_stdin`) → builtin key `"global.readStdin"` → emit_c.rs:14233 → `ts_read_stdin` ts_rt.c:2297, decl ts_rt.h:1139 | THE pattern for every new host API |
| Ambient-builtin gate | `isAmbientGlobalSymbol`/`isBuiltinSymbol` (exporter.ts ~726-760; symbol counts as builtin iff ALL declarations are in `.d.ts` files) | injected `garnet_node.d.ts` decls are builtins automatically — no gate change needed |
| Builtin namespace set | exporter.ts:1255 (`Math, Number, …, Reflect`) | N2 adds `"process"` |
| Module linkage / loud reject | `tryHandleLinkage` exporter.ts:5120-5189 | N3/N4 relax specific rejects |
| Module resolution | `resolveModuleSf` exporter.ts:10545; `moduleDeps` :10566; compiler opts :65-86 (`moduleResolution: Bundler`, no `lib` ⇒ default full lib INCLUDING DOM — `setTimeout`/`fetch`/`console` already type-check; `process` does NOT) | N3 adds a `resolveModuleNameLiterals` override |
| Program creation | `ts.createProgram([input], opts)` exporter.ts:~11188 | N2 adds the ambient d.ts to rootNames; N3 adds the custom host |
| Generated `main` | emit_c.rs:992 (`int main(void)`), proto setup :993-1013, `ts_run_event_loop()` call :1047-1049 | N2 changes signature to capture argc/argv |
| Whole-program untyped mode | `untyped` flag exporter.ts:246-256 (`TSAOT_UNTYPED=1`) | N5 builds on it |
| Conformance harness | `scripts/run_conformance.sh` — tiers under `tests/conformance/<tier>/**/*.ts` | new `basic/node/` subtree, harness unchanged |

## 4. Architecture: three layers

```
user program (TS; later JS)
   │  import { readFileSync } from "node:fs";   setTimeout(...)
   ▼
[L3] exporter compile-time resolution
   - "node:*" specifiers → bundled TS shims (exporter/node_shims/*.ts)   (N3)
   - bare npm specifiers → node_modules resolution                      (N4)
   - ambient globals (setTimeout, process, __fs_*) → CallBuiltinStatic  (N1/N2)
   ▼
[L2] TS shims, compiled by garnet itself (dogfooding; Node does the same with lib/*.js)
   - node_shims/fs.ts, path.ts, os.ts, util.ts, events.ts
   - pure TS on top of L1 primitives; strict; type-check under the normal profile
   ▼
[L1] C host primitives in runtime/ts_rt.c (small, flat, throw-on-error)
   - timers + loop (N1), __proc_* (N2), __fs_* (N3), sockets/uv (N7)
```

Conventions:
- Ambient host primitives are double-underscore snake_case (`__fs_read_file_utf8`),
  following the `__read_stdin` precedent (analyzer_ts/src/host.d.ts:8). They are declared in
  a NEW file `exporter/garnet_node.d.ts` (created in N2), and are internal API — user code
  may technically call them, that is harmless.
- Builtin keys are namespaced strings: `global.setTimeout`, `process.argv`,
  `nodefs.readFileUtf8` — same style as the existing `date.now` / `object.keys` arms.
- Runtime functions are `ts_*` flat C names, declared in ts_rt.h next to their section.

---

## 5. Phase N1 — timers + event-loop generalization

Deliverable: `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` /
`queueMicrotask`, with node-compatible ordering, and the loop able to sleep until the next
deadline. All five already type-check (DOM lib) and hit `isAmbientGlobalSymbol` — only
lowering + runtime are missing.

### 5.1 Semantics contract (what the conformance tests assert)

- Delay clamping (node behavior): coerce ms with ToNumber; if `NaN`, `< 1`, or `> 2^31-1` →
  use `1`. (`setTimeout(cb)` with no delay ⇒ 1 ms.)
- Same-deadline timers fire in creation order (FIFO tie-break by sequence number).
- All due-timer callbacks run, and microtasks are drained between macrotask callbacks
  (spec: microtask checkpoint after each callback — see §5.6 loop shape).
- `setInterval` re-arms BEFORE invoking the callback; `clearInterval` from inside the
  callback cancels the already-re-armed next firing.
- `clearTimeout`/`clearInterval` accept the returned id; unknown/expired ids are no-ops;
  `clearTimeout(undefined)` is a no-op (node allows it).
- A pending timer keeps the process alive (loop does not exit); an interval keeps it alive
  forever until cleared — conformance tests MUST clear their intervals.
- Extra callback arguments `setTimeout(cb, ms, a, b)` → **compile-time loud reject** in v1.
- Callback throw → normal `ts_throw`; if uncaught it reaches the empty-handler path and
  aborts (ts_rt.c:8859-8868). Because the harness diffs combined output (R-E), there is NO
  conformance test for the uncaught case — tests wrap intentional errors in try/catch.
- Divergence D1 (handle is a number) — tests never print or `typeof` the handle.

### 5.2 Step T1 — runtime: timer store (commit 1, dead code)

`runtime/ts_rt.c`, new section directly BELOW the abort-timer block (after ts_rt.c:9812), so
both timer families sit together. Add to ts_rt.h (near the `ts_read_stdin` decl, :1139):

```c
/* ---- node-compat timers (docs/node_compat_design.md §5) ---- */
tsv  ts_set_timeout(tsv cb, tsv ms, int repeat);   /* returns timer id as a number */
tsv  ts_clear_timer(tsv idv);                       /* returns TS_UNDEFINED */
tsv  ts_queue_microtask(tsv cb);                    /* returns TS_UNDEFINED */
```

Implementation (ts_rt.c). A sorted singly-linked list, exactly like the abort timers — NOT a
heap; programs with thousands of live timers are out of profile for v1 (leave a `/* upgrade
to 4-ary heap if profiles ever show timer-insert cost */` note):

```c
/* ---------------- node-compat timers (docs/node_compat_design.md §5) ---------------- */
typedef struct ts_timer {
  double   deadline_ms;         /* ts_now_mono_ms() based */
  double   interval_ms;         /* >= 1: setInterval period; < 0: one-shot */
  uint32_t id;                  /* monotonically increasing, returned to JS */
  uint32_t seq;                 /* creation order; FIFO tie-break at equal deadlines */
  tsv      cb;                  /* GC-marked via gc_mark_node_timer_roots */
  struct ts_timer* next;
} ts_timer;
static ts_timer* g_node_timers = NULL;      /* sorted by (deadline_ms, seq) */
static uint32_t  g_timer_next_id = 1;
static uint32_t  g_timer_next_seq = 1;

static double ts_now_mono_ms(void){
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec*1000.0 + (double)ts.tv_nsec/1.0e6;
}

/* node's clamp: NaN, <1, >2^31-1  =>  1 */
static double timer_clamp_delay(tsv msv){
  double d = ts_number_coerce(msv);
  if (!(d >= 1.0) || d > 2147483647.0) return 1.0;   /* !(d>=1) catches NaN */
  return floor(d);
}

static void timer_insert(ts_timer* t){
  ts_timer** pp = &g_node_timers;
  while (*pp && ((*pp)->deadline_ms < t->deadline_ms ||
                 ((*pp)->deadline_ms == t->deadline_ms && (*pp)->seq < t->seq)))
    pp = &(*pp)->next;
  t->next = *pp; *pp = t;
}

tsv ts_set_timeout(tsv cb, tsv ms, int repeat){
  if (!ts_is_callable(cb))     /* if no such helper exists, check kind==TS_KIND_FUNC */
    ts_throw(/* TypeError-shaped object; reuse the abort_reason_object pattern
                (ts_rt.c:9714-9721) with name "TypeError",
                message "setTimeout callback must be a function" */);
  double delay = timer_clamp_delay(ms);
  ts_timer* t = (ts_timer*)calloc(1, sizeof(ts_timer));
  if (!t) ts_abort_msg("out of memory creating timer");
  t->deadline_ms = ts_now_mono_ms() + delay;
  t->interval_ms = repeat ? delay : -1.0;
  t->id  = g_timer_next_id++;
  t->seq = g_timer_next_seq++;
  t->cb  = cb;
  timer_insert(t);
  return ts_num((double)t->id);
}

tsv ts_clear_timer(tsv idv){
  double d = ts_number_coerce(idv);          /* undefined -> NaN -> matches nothing */
  ts_timer** pp = &g_node_timers;
  while (*pp){
    if ((double)(*pp)->id == d){ ts_timer* t=*pp; *pp=t->next; free(t); return TS_UNDEFINED; }
    pp = &(*pp)->next;
  }
  return TS_UNDEFINED;
}

static int  ts_node_timers_pending(void){ return g_node_timers != NULL; }
static void gc_mark_node_timer_roots(void){
  for (ts_timer* t=g_node_timers;t;t=t->next) gc_mark_value(t->cb);
}
static void gc_mark_node_timer_roots_young(void){
  for (ts_timer* t=g_node_timers;t;t=t->next) gc_mark_value_young(t->cb);
}
```

Firing — the ONE subtle function. Contract details in comments; keep them:

```c
static void ts_node_timers_fire_due(void){
  if (!g_node_timers) return;
  double now = ts_now_mono_ms();
  /* Snapshot semantics: only timers due at entry fire in this pass; a timer armed
     by a callback for "now" fires on the NEXT loop iteration (matches node closely
     enough for ordering tests; exact node phase mechanics are out of scope). */
  while (g_node_timers && g_node_timers->deadline_ms <= now){
    ts_timer* t = g_node_timers;
    g_node_timers = t->next;
    tsv cb = t->cb;
    ts_gc_root(&cb);
    if (t->interval_ms >= 1.0){
      /* re-arm BEFORE the call so clearInterval(id) inside the callback finds it */
      t->deadline_ms = now + t->interval_ms;
      t->seq = g_timer_next_seq++;
      timer_insert(t);
    } else {
      free(t);                       /* id becomes unknown; later clear is a no-op */
    }
    /* Call with a dummy args pointer: ts_call_value's takes_this path memcpys
       from `args` (ts_rt.c:624-640); NULL+0 is technically UB under sanitizers. */
    tsv noargs[1];
    ts_call_value(cb, noargs, 0);    /* may throw — see note below */
    ts_gc_unroot(1);
    /* microtask checkpoint between macrotask callbacks (spec ordering) */
    drain_microtasks();
    now = ts_now_mono_ms();
  }
}
/* Throw-path note: if the callback throws and nothing inside it caught, ts_throw
   finds g_handlers empty at loop depth and aborts the process (ts_rt.c:8859), so
   the skipped ts_gc_unroot(1) is never observable. This mirrors how microtask
   resumes behave (ts_coro_resume_v eh-wraps and restores root depth itself,
   ts_rt.c:9420-9434). If timers ever become cancellable from C cleanup paths,
   revisit with the eh-push pattern. */

/* poll-timeout contribution, mirroring ts_abort_timer_poll_timeout_ms (ts_rt.c:9789) */
static int ts_node_timer_poll_timeout_ms(int default_ms){
  if (!g_node_timers) return default_ms;
  double remain = g_node_timers->deadline_ms - ts_now_mono_ms();
  if (remain <= 0.0) return 0;
  if (remain > (double)default_ms) return default_ms;
  return (int)ceil(remain);
}
```

`queueMicrotask`: the microtask queue holds coros only (`microq_push_v` rejects non-coros,
ts_rt.c:8948-8952). Wrap the callback in an adapter coro, copying the `ts_adopt` pattern
(struct at ts_rt.c:8992, resume fn :8993-9007, and the allocation just below it — mirror the
alloc exactly: `gc_alloc(sizeof(...), TS_KIND_CORO)`, set `resume`, set `frame_size =
sizeof(struct)` so the conservative coro-frame scan (ts_rt.c:9523-9531) sees `cb`):

```c
typedef struct { ts_coro c; tsv cb; } ts_cbtask;
static tsv cbtask_resume(tsv cv){
  ts_cbtask* w = (ts_cbtask*)ts_ptr(cv);
  tsv cb = w->cb;
  ts_gc_root(&cb);
  tsv noargs[1];
  ts_call_value(cb, noargs, 0);
  ts_gc_unroot(1);
  return TS_UNDEFINED;
}
tsv ts_queue_microtask(tsv cb){
  /* callable check as in ts_set_timeout */
  /* alloc + init exactly like the ts_adopt constructor, then: */
  microq_push_v(cv);
  return TS_UNDEFINED;
}
```

GC wiring (same commit): append `gc_mark_node_timer_roots();` inside `gc_mark_async_roots`
(ts_rt.c:9535-9540) and the `_young` twin inside `gc_mark_async_roots_young` (:9541-9546).
Miss one of the two and you get a young-collection use-after-free — this is the #1 trap.

Gate for commit 1: builds clean; conformance untouched-green (dead code); GC-stress green.

### 5.3 Step T2 — event loop rewrite (commit 2, the only shared-path edit)

Replace `ts_run_event_loop` (ts_rt.c:9498-9508) with:

```c
void ts_run_event_loop(void){
  for (;;){
    drain_microtasks();
    ts_abort_timers_fire_due();
    ts_node_timers_fire_due();               /* runs JS; drains microtasks itself */
    ts_io_start_queued();
    if (g_mq_len) continue;                  /* JS just queued more microtasks */
    int have_io     = (g_io_head || g_io_active) ? 1 : 0;
    int have_timers = ts_node_timers_pending();
    if (!have_io && !have_timers) break;     /* nothing pending: program done */
    if (g_io_active){ (void)ts_io_poll_active(); continue; }
    /* timers only: sleep until the nearest deadline (cap keeps abort timers live) */
    if (have_timers){
      int ms = ts_node_timer_poll_timeout_ms(100);
      if (ms > 0) poll(NULL, 0, ms);         /* <poll.h>; EINTR: just loop again */
    }
  }
}
```

Also: inside the fetch poll path, wherever `ts_abort_timer_poll_timeout_ms(default)` computes
the curl timeout (grep its call sites), wrap it so the general timers cap it too:
`ms = ts_node_timer_poll_timeout_ms(ts_abort_timer_poll_timeout_ms(default));` — otherwise a
long fetch poll delays a short `setTimeout`.

Gate for commit 2: full conformance (`run_conformance.sh all`) green — this proves the
rewritten loop preserves the pure-promise and fetch behavior; fetch test
(`scripts/run_fetch_test.sh`) green; **flagship A/B bench** (loop body is shared path; expect
Δ = noise since programs without timers hit two extra predictable branches per loop
iteration, not per instruction); GC-stress green.

### 5.4 Step T3 — exporter lowering (commit 3)

In the global-builtin call chain, insert after the `__read_stdin` arm (exporter.ts:3813-3817),
following the `parseInt` arm shape (:3818-3823):

```ts
if ((fn.text === "setTimeout" || fn.text === "setInterval") && isBuiltinSym) {
  if (node.arguments.length > 2)
    this.unsupported(node, "setTimeout/setInterval extra callback arguments not supported (node-compat v1, docs/node_compat_design.md §5.1)");
  if (node.arguments.length === 0)
    this.unsupported(node, "setTimeout/setInterval requires a callback");
  const cb = this.lowerExpr(ctx, node.arguments[0]);
  const ms = node.arguments.length > 1
    ? this.lowerExpr(ctx, node.arguments[1])
    : this.lowerNumberConst(ctx, 0);   // if no such helper: lower a NumericLiteral 0 the way
                                       // existing default-argument code does; runtime clamps 0 -> 1
  const dst = this.newLocal(ctx, "primitive");
  ctx.body.push({ kind: "CallBuiltinStatic", dst,
    builtin: fn.text === "setTimeout" ? "global.setTimeout" : "global.setInterval",
    args: [cb, ms] });
  return dst;
}
if ((fn.text === "clearTimeout" || fn.text === "clearInterval") && isBuiltinSym) {
  const argLs = node.arguments.length ? [this.lowerExpr(ctx, node.arguments[0])]
                                      : [this.lowerUndefined(ctx)];  // clearTimeout() is a no-op
  const dst = this.newLocal(ctx, "reference");
  ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "global.clearTimer", args: argLs });
  return dst;
}
if (fn.text === "queueMicrotask" && isBuiltinSym) {
  const argLs = [this.lowerExpr(ctx, node.arguments[0])];
  const dst = this.newLocal(ctx, "reference");
  ctx.body.push({ kind: "CallBuiltinStatic", dst, builtin: "global.queueMicrotask", args: argLs });
  return dst;
}
```

(`lowerNumberConst`/`lowerUndefined`: use whatever existing helpers lower a numeric/undefined
literal — locate by reading how optional arguments are defaulted elsewhere in this file;
do not invent new IR.)

### 5.5 Step T4 — emit_c arms (commit 3, same commit as T3)

In the `CallBuiltinStatic` match, next to `"global.readStdin"` (emit_c.rs:14233):

```rust
"global.setTimeout"     => (format!("ts_to_num(ts_set_timeout({}, {}, 0))", v(0), v(1)), true),
"global.setInterval"    => (format!("ts_to_num(ts_set_timeout({}, {}, 1))", v(0), v(1)), true),
"global.clearTimer"     => (format!("ts_clear_timer({})", v(0)), false),
"global.queueMicrotask" => (format!("ts_queue_microtask({})", v(0)), false),
```

Flag discipline (matches the `date.now` arm at emit_c.rs:14237): `true` = the C expression
yields an UNBOXED double, pairing with the exporter's "primitive" dst for
setTimeout/setInterval; `ts_to_num` on the freshly built `ts_num(id)` is exact because
numbers are NaN-box-immediate (the CLAUDE.md `ts_to_num` caveat is about non-number inputs,
which cannot occur here). `clearTimer`/`queueMicrotask` return boxed `TS_UNDEFINED` →
`false` with "reference" dst — a flag/dst mismatch here is the silent-value-corruption
class, so re-check this pairing at review time.

### 5.6 Step T5 — conformance tests (commit 4)

New directory `tests/conformance/basic/node/timers/`. Node runs them natively (R-E), so no
harness change. Minimum set (delays ≤ 20 ms to keep the suite fast; NEVER print handles, D1):

```
timer_order.ts        setTimeout(f,0)×3 → creation order; interleaved console.log
timer_vs_microtask.ts sync log → Promise.then log → setTimeout log (checkpoint ordering)
timer_nested.ts       setTimeout arming setTimeout; total order
interval_clear.ts     setInterval counting to 3 then clearInterval(id) from inside
clear_foreign.ts      clearTimeout(undefined); clearTimeout(999999); then one real timer
queue_microtask.ts    queueMicrotask vs .then vs setTimeout ordering
timer_error_caught.ts callback body: try { throw } catch { console.log(...) } — proves a
                      throwing callback doesn't corrupt the loop/root stack (uncaught-throw
                      behavior is untestable via the oracle, R-E/D6)
```

### 5.7 Step T6 — reachability guards (commit 5)

The builtin arms in §5.4 only fire on DIRECT calls of the ambient identifiers. Two other
reachable spellings would silently miss them and fall into the dynamic global-object path,
where `setTimeout` is NOT a property (nothing registers it in `ts_setup_global_object`) —
yielding `undefined` → runtime TypeError instead of a working timer. Close both loudly:

1. `globalThis.setTimeout(...)` (and the other four): in the globalThis member handling,
   loud-reject these member names — precedent: `globalThis.RegExp as a value` reject at
   exporter.ts:3124. Message: `globalThis.setTimeout not supported — call setTimeout
   directly (node-compat v1, docs/node_compat_design.md §5.7)`.
2. Value-position use (`const f = setTimeout;`, passing `setTimeout` as an argument):
   loud-reject via the same identifier arms (when the builtin identifier is NOT the callee
   of a direct call). Same treatment as any future attempt to reassign them
   (`setTimeout = myFake` — the mutated-global machinery at exporter.ts:3791 must also
   reject rather than route to the dynamic path).

Add loud-reject tests for both spellings (negative-compile tests, same style as the module
linkage rejects). N2 applies the identical rule to `process` (§6.5 already rejects
`process` in value position; add `globalThis.process`).

Phase N1 exit gate: conf all green + unit + `ci_fast` + GC-stress + flagship A/B (§5.3) +
bundler suite green.

---

## 6. Phase N2 — `process` global

Deliverable: `process.argv/env/platform/exit/cwd/nextTick/stdout.write/stderr.write`, argv
capture in generated `main`, nextTick-before-microtask ordering.

### 6.1 Step P1 — ambient declarations file (commit 1)

New file `exporter/garnet_node.d.ts` (this file also carries the N3 `__fs_*` decls later):

```ts
// Ambient declarations for garnet's node-compat surface.
// Declarations here are automatically "builtin" for the exporter because
// isBuiltinSymbol accepts any symbol declared only in .d.ts files.
interface GarnetWritableStd { write(chunk: string): boolean; }
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  platform: string;
  exit(code?: number): never;
  cwd(): string;
  nextTick(cb: () => void): void;
  stdout: GarnetWritableStd;
  stderr: GarnetWritableStd;
};
```

Wire it into the program: at the `ts.createProgram([input], opts)` site (exporter.ts:~11188)
add the d.ts path to rootNames unconditionally:
`ts.createProgram([input, path.join(__dirname, "garnet_node.d.ts")], opts)`.
It is a declaration file, so `resolveModuleSf` ignores it (exporter.ts:10555 filters
`isDeclarationFile`) and no runtime code is emitted for it. NOTE: the conformance harness
builds the exporter with tsc (run_conformance.sh) — make sure the d.ts ships next to
exporter.js (it is read via the filesystem at compile time, not imported).

DANGER (silent-miscompile class): the DOM lib may ALSO gain/have conflicting globals; if tsc
reports a duplicate-identifier error for `process`, rename nothing — scope our declaration
with `declare global` inside a module file instead. Resolve at implementation time.

### 6.2 Step P2 — argv capture in generated main (commit 1)

emit_c.rs:992: `"int main(void){\n"` → `"int main(int argc, char** argv){\n"`, and after
`ts_setup_globals();` (:1014) add `s.push_str("  ts_proc_init(argc, argv);\n");`.
This changes EVERY emitted program → byte-parity vs frozen fixtures breaks. Coordinate with
the parity policy exactly like root_batching_design §S5: this is an emit-affecting change and
must ride a planned parity event (or land before/after one), never silently.

### 6.3 Step P3 — runtime primitives (commit 1, with P2)

ts_rt.h decls + ts_rt.c section (below the timers). All results cached in static tsv globals
rooted once via `ts_root_static_once` (ts_rt.c:473 precedent):

```c
void ts_proc_init(int argc, char** argv);         /* stores argc/argv pointers */
tsv  ts_proc_argv(void);      /* cached array: [execpath, execpath, argv[1..]] (D2) */
tsv  ts_proc_env(void);       /* cached plain object snapshot of environ (D3) */
tsv  ts_proc_platform(void);  /* "darwin" / "linux" via #ifdef __APPLE__ */
tsv  ts_proc_exit(tsv code);  /* fflush(stdout); exit((int)ts_number_coerce or 0) */
tsv  ts_proc_cwd(void);       /* getcwd -> string; throw on failure */
tsv  ts_proc_next_tick(tsv cb);
tsv  ts_proc_std_write(tsv s, int fd);  /* fwrite utf8 bytes; returns ts_bool(1) */
```

`ts_proc_env`: iterate `extern char **environ`; split at first `=`; build with
`ts_new_object`/`ts_set`/`ts_intern_field` (see abort_reason_object, ts_rt.c:9714-9721, for
the exact call shape + rooting). `ts_proc_argv`: `ts_new_array`-equivalent (find the array
constructor used by `ts_object_keys` and mirror it).

### 6.4 Step P4 — nextTick queue + drain interleave (commit 2)

New FIFO `g_ntq` of adapter coros (reuse `ts_cbtask` from §5.2 — nextTick and queueMicrotask
share the adapter; only the queue differs). Ordering contract (node ≥ 11): all pending
nextTicks run before the next microtask, and again between microtasks.

Replace the body of `drain_microtasks` (ts_rt.c:9489-9496):

```c
static void drain_ticks(void){
  int i=0;
  while (i<g_nt_len){ ts_coro_resume_v(g_ntq[i++]); }
  g_nt_len=0;
}
static void drain_microtasks(void){
  for (;;){
    if (g_nt_len) drain_ticks();
    if (!g_mq_len) return;
    /* run exactly ONE microtask, then give nextTick another chance */
    tsv cv = g_microq[0];
    memmove(g_microq, g_microq+1, sizeof(tsv)*(size_t)(g_mq_len-1));
    g_mq_len--;
    ts_coro_resume_v(cv);
  }
}
```

PERF NOTE (R-B): the old drain was index-walk + single reset; the new one memmoves per task.
If the flagship A/B shows regression, switch to a head-index ring (`g_mq_head`) instead of
memmove — decide by measurement, not taste. `g_ntq` needs the same GC marks as `g_microq`
(gc_mark_async_roots + young, §5.2 trap applies).

### 6.5 Step P5 — exporter lowering for `process.*` (commit 3)

1. Add `"process"` to the builtin namespace set (exporter.ts:1255).
2. Locate where namespace members are dispatched (the code that turns `Date.now()` /
   `JSON.parse(x)` into `CallBuiltinStatic` — find it via the `date.now` builtin key). Add a
   `process` branch:
   - calls: `exit` (0/1 args) → `process.exit`; `cwd` () → `process.cwd`; `nextTick`
     (exactly 1 arg, else loud reject) → `process.nextTick`.
   - property reads: `argv` → `process.argv`; `env` → `process.env`; `platform` →
     `process.platform`.
   - nested call pattern `process.stdout.write(x)` / `process.stderr.write(x)` (a call whose
     callee is a PropertyAccess `write` on a PropertyAccess `stdout|stderr` on the `process`
     builtin ref) → `process.stdoutWrite` / `process.stderrWrite` with 1 arg (must be typed
     string; non-string → loud reject "Buffer not implemented").
   - ANY other member, and `process` used as a bare value (passed/stored/spread) → loud
     reject: `process.<name> not supported yet (node-compat N2, docs/node_compat_design.md §6)`.
3. emit_c arms (next to the N1 arms):

```rust
"process.argv"        => ("ts_proc_argv()".to_string(), false),
"process.env"         => ("ts_proc_env()".to_string(), false),
"process.platform"    => ("ts_proc_platform()".to_string(), false),
"process.exit"        => (format!("ts_proc_exit({})", if args.len()>0 { v(0) } else { "TS_UNDEFINED".into() }), false),
"process.cwd"         => ("ts_proc_cwd()".to_string(), false),
"process.nextTick"    => (format!("ts_proc_next_tick({})", v(0)), false),
"process.stdoutWrite" => (format!("ts_proc_std_write({}, 1)", v(0)), false),
"process.stderrWrite" => (format!("ts_proc_std_write({}, 2)", v(0)), false),
```

### 6.6 N2 conformance + gates

`tests/conformance/basic/node/process/`: `argv_slice2.ts` (harness passes no extra args →
`slice(2)` prints `[]`), `env_roundtrip.ts` (read a var the harness sets identically for both
runs — if it can't, read `PATH !== undefined` as a boolean), `next_tick_order.ts`
(nextTick vs .then vs setTimeout — THE ordering test), `exit_code.ts` (only if the harness
checks exit codes; else assert via output-before-exit), `stdout_write.ts`.
Exit gate: same battery as N1 + parity-event coordination for §6.2.

---

## 7. Phase N3 — `node:` module resolution + fs/path/os/util/events shims

Deliverable: `import ... from "node:fs" | "node:path" | "node:os" | "node:util" |
"node:events"` (and prefix-less `"fs"` etc.) work; everything else `node:*` fails with a
message listing what IS supported.

### 7.1 Step S1 — shim resolution in the exporter (commit 1)

New directory `exporter/node_shims/` containing `fs.ts, path.ts, os.ts, util.ts, events.ts`.
Resolution map + compiler-host override at the program-creation site (exporter.ts:~11188):

```ts
const NODE_SHIM_DIR = path.join(__dirname, "node_shims");
const NODE_SHIMS = new Set(["fs", "path", "os", "util", "events"]);
function nodeShimFile(spec: string): string | undefined {
  const name = spec.startsWith("node:") ? spec.slice(5) : spec;
  return NODE_SHIMS.has(name) ? path.join(NODE_SHIM_DIR, name + ".ts") : undefined;
}
const NODE_BUILTIN_NAMES = new Set(["assert","buffer","child_process","crypto","fs","http",
  "https","net","os","path","stream","url","util","events","zlib","readline","worker_threads",
  "tty","dns","dgram","cluster","vm","v8","perf_hooks","string_decoder","querystring",
  "timers","process","module","constants"]);

const host = ts.createCompilerHost(opts);
host.resolveModuleNameLiterals = (lits, containingFile, _redir, options) =>
  lits.map((lit) => {
    const shim = nodeShimFile(lit.text);
    if (shim) return { resolvedModule: {
      resolvedFileName: shim, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
    return { resolvedModule:
      ts.resolveModuleName(lit.text, containingFile, options, host).resolvedModule };
  });
const program = ts.createProgram([input, dtsPath], opts, host);
```

Because resolution now succeeds, `resolveModuleSf` (exporter.ts:10545) returns the shim
SourceFile, `moduleDeps` (:10566) pulls it into the bundle DFS, and `tryHandleLinkage`
accepts the import — no linkage-code change needed for supported modules. For UNSUPPORTED
node modules, improve the existing reject (exporter.ts:5129/5138/5165): if the specifier
starts with `node:` or is in `NODE_BUILTIN_NAMES`, the message becomes:
`node builtin module "<spec>" is not implemented (implemented: fs, path, os, util, events — docs/node_compat_design.md §7)`.

Shim rules: shims are ordinary bundled strict TS — they must compile under the normal
profile with zero `unsupported` hits, and they may only use L1 primitives + already-supported
language features (verified during review: parameter properties (exporter.ts:9765),
rest params/spread (:203/:1022), Map/`splice`/`indexOf` builtin arms all exist — the §7.3
code as written is inside today's supported surface). Shims must be side-effect-free at top
level (declarations only): they execute before user code in the bundle's DFS post-order, and
any top-level effect would change program-observable ordering. Adding a shim = adding conformance tests for it (CLAUDE.md completion
criteria). Shims ship next to exporter.js (same packaging note as §6.1).

### 7.2 Step S2 — fs host primitives (commit 2)

`exporter/garnet_node.d.ts` additions:

```ts
declare function __fs_read_file_utf8(path: string): string;
declare function __fs_write_file_utf8(path: string, data: string, append: boolean): void;
declare function __fs_exists(path: string): boolean;
declare function __fs_stat(path: string): { kind: number; size: number; mtimeMs: number }; // kind: 0 file, 1 dir, 2 other
declare function __fs_readdir(path: string): string[];
declare function __fs_mkdir(path: string, recursive: boolean): void;
declare function __fs_rm(path: string, recursive: boolean, force: boolean): void;
declare function __util_inspect(v: unknown): string;   // §7.3 util shim; reuses console's formatter
```

Exporter arms: clone the `__read_stdin` arm (exporter.ts:3813-3817) once per function →
builtin keys `nodefs.readFileUtf8`, `nodefs.writeFileUtf8`, `nodefs.exists`, `nodefs.stat`,
`nodefs.readdir`, `nodefs.mkdir`, `nodefs.rm`. emit_c arms map to `ts_fs_*` C functions.

Runtime `ts_fs_*` (ts_rt.c, new section): thin POSIX wrappers (`open/read/fstat` or
`fopen/fread`, `stat`, `opendir/readdir`, `mkdir` with recursive walk, `unlink/rmdir` with
recursive walk). **`ts_fs_readdir` MUST sort entries with `strcmp`** (qsort) before building
the array: node's `readdirSync` returns libuv `scandir`+`alphasort` order on POSIX, while raw
`readdir(3)` order is arbitrary (APFS!) — an unsorted implementation diffs against the oracle
nondeterministically, which is the worst failure mode to debug. `.` and `..` are excluded. Error path — build and `ts_throw` a node-shaped error (pattern:
abort_reason_object, ts_rt.c:9714-9721) with fields `name:"Error"`, `code`, `errno`,
`syscall`, `path`, `message`:

```c
static const char* fs_err_text(int e){
  switch(e){
    case ENOENT:    return "no such file or directory";
    case EACCES:    return "permission denied";
    case EEXIST:    return "file already exists";
    case EISDIR:    return "illegal operation on a directory";
    case ENOTDIR:   return "not a directory";
    case ENOTEMPTY: return "directory not empty";
    default:        return "unknown error";
  }
}
static const char* fs_err_code(int e){
  switch(e){
    case ENOENT: return "ENOENT"; case EACCES: return "EACCES"; case EEXIST: return "EEXIST";
    case EISDIR: return "EISDIR"; case ENOTDIR: return "ENOTDIR"; case ENOTEMPTY: return "ENOTEMPTY";
    default: return "UNKNOWN"; } }
/* message format matches libuv/node: "<CODE>: <text>, <syscall> '<path>'" */
```

`.code` is the compat contract (D4); tests compare `err.code`, not `err.message`.
UTF-8 note: `__fs_read_file_utf8` must validate/transcode into the runtime's string encoding
the same way `ts_read_stdin` (ts_rt.c:2297) does — read that function first and reuse its
byte→string entry point; do NOT invent a second ingestion path.

### 7.3 Step S3 — the shims themselves (commits 3..7, one module per commit)

`node_shims/fs.ts` (excerpt; the Buffer-shaped holes are LOUD, R-A):

```ts
export function readFileSync(p: string, encoding?: string): string {
  if (encoding === undefined)
    throw new Error("fs.readFileSync without an encoding returns a Buffer; garnet has no Buffer yet — pass 'utf8' (docs/node_compat_design.md §7)");
  if (encoding !== "utf8" && encoding !== "utf-8")
    throw new Error(`fs.readFileSync: unsupported encoding '${encoding}' (garnet v1: utf8 only)`);
  return __fs_read_file_utf8(p);
}
export function writeFileSync(p: string, data: string): void { __fs_write_file_utf8(p, data, false); }
export function appendFileSync(p: string, data: string): void { __fs_write_file_utf8(p, data, true); }
export function existsSync(p: string): boolean { return __fs_exists(p); }
export function readdirSync(p: string): string[] { return __fs_readdir(p); }
export function mkdirSync(p: string, opts?: { recursive?: boolean }): void { __fs_mkdir(p, !!(opts && opts.recursive)); }
export function rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void {
  __fs_rm(p, !!(opts && opts.recursive), !!(opts && opts.force));
}
export class Stats {
  constructor(private k: number, public size: number, public mtimeMs: number) {}
  isFile(): boolean { return this.k === 0; }
  isDirectory(): boolean { return this.k === 1; }
}
export function statSync(p: string): Stats { const s = __fs_stat(p); return new Stats(s.kind, s.size, s.mtimeMs); }
```

`node_shims/path.ts` — pure TS, posix-only (§1.3). Implement `sep`, `isAbsolute`, `join`,
`normalize`, `dirname`, `basename`, `extname`, `resolve`, `relative`. The core everything
routes through:

```ts
// Resolves "." and ".." segments; keeps leading ".." for relative inputs.
function normalizeSegments(parts: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const s of parts) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else out.push(s);
  }
  return out;
}
export const sep = "/";
export function isAbsolute(p: string): boolean { return p.length > 0 && p[0] === "/"; }
export function normalize(p: string): string {
  if (p.length === 0) return ".";
  const abs = isAbsolute(p);
  const trailing = p.length > 1 && p[p.length - 1] === "/";
  const segs = normalizeSegments(p.split("/"), abs);
  let out = segs.join("/");
  if (out.length === 0) out = abs ? "/" : ".";
  else if (abs) out = "/" + out;
  if (trailing && out[out.length - 1] !== "/") out += "/";
  return out;
}
export function join(...parts: string[]): string {
  const joined = parts.filter((s) => s.length > 0).join("/");
  return joined.length === 0 ? "." : normalize(joined);
}
export function resolve(...parts: string[]): string {
  let acc = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].length === 0) continue;
    acc = acc.length === 0 ? parts[i] : parts[i] + "/" + acc;
    if (isAbsolute(parts[i])) break;
  }
  if (!isAbsolute(acc)) acc = process.cwd() + "/" + acc;
  const segs = normalizeSegments(acc.split("/"), true);
  return "/" + segs.join("/");
}
// dirname/basename/extname/relative: transliterate node's algorithms (they are short);
// oracle-diff every edge case (trailing slashes, dotfiles, "" inputs) — node decides.
```

`node_shims/os.ts`: `platform()` → `process.platform`; `homedir()` / `tmpdir()` via
`process.env.HOME` / `process.env.TMPDIR` with node's fallbacks (`tmpdir`: TMPDIR → "/tmp",
trailing slash stripped); `EOL = "\n"`.

`node_shims/events.ts` — pure TS, no host primitives (full class; this is the whole v1 file):

```ts
type Listener = (...args: unknown[]) => void;
export class EventEmitter {
  private m = new Map<string, Listener[]>();
  on(ev: string, fn: Listener): this {
    const a = this.m.get(ev); if (a) a.push(fn); else this.m.set(ev, [fn]); return this;
  }
  once(ev: string, fn: Listener): this {
    const wrap: Listener = (...args: unknown[]) => { this.off(ev, wrap); fn(...args); };
    return this.on(ev, wrap);
  }
  off(ev: string, fn: Listener): this {
    const a = this.m.get(ev);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return this;
  }
  removeAllListeners(ev?: string): this {
    if (ev === undefined) this.m.clear(); else this.m.delete(ev); return this;
  }
  emit(ev: string, ...args: unknown[]): boolean {
    const a = this.m.get(ev);
    if (!a || a.length === 0) {
      if (ev === "error") throw (args[0] !== undefined ? args[0] : new Error("Unhandled error."));
      return false;
    }
    for (const fn of a.slice()) fn(...args);   // slice: node snapshots before dispatch
    return true;
  }
  listenerCount(ev: string): number { const a = this.m.get(ev); return a ? a.length : 0; }
}
export default EventEmitter;
```

(If rest-args/spread in this exact shape hits an exporter `unsupported`, that gap becomes a
prerequisite bug-fix commit BEFORE the shim lands — do not water the shim down silently.)

`node_shims/util.ts` v1: `format` (only `%s %d %i %f %j %%`, then remaining args appended
space-separated — transliterate node's algorithm, oracle-diff it) and `inspect` delegating to
a new host primitive `__util_inspect(v: unknown): string` that reuses console.log's existing
value formatter (find it from the console implementation around ts_rt.c:2235-2293; expose the
string-building entry as `ts_util_inspect(tsv)` — do NOT write a second formatter).

### 7.4 N3 conformance + gates

`tests/conformance/basic/node/{fs,path,os,util,events}/`. fs tests: create a unique work dir
under `os.tmpdir() + "/garnet_fs_" + <fixed name per test>`, full round-trip (mkdir → write →
read → readdir → stat → rm), `try/catch` printing `err.code` for ENOENT/EEXIST cases, always
`rmSync(..., {recursive: true, force: true})` in a `finally`. Both oracle and native run the
same cleanup, so reruns are deterministic. path tests: table-driven over edge cases. Exit
gate: full battery; M1 reached.

---

## 8. Phase N4 — node_modules resolution (ESM packages, compile-time)

Needs its own short design doc at implementation time; the contract:

- Scope: bare specifiers (`"pkg"`, `"@scope/pkg"`, `"pkg/subpath"`) resolved at COMPILE time
  by the exporter, whole-program-bundled like any user module. No runtime loader exists.
- Algorithm (Node's ESM resolution, reduced): walk up from the importing file's dir looking
  for `node_modules/<name>/package.json`; resolve subpath via `"exports"` with condition set
  `["node", "import", "default"]` (string form, object form, subpath map, single-`*`
  patterns); no `"exports"` → `"module"` then `"main"` then `index.js`; `"imports"`
  (`#alias`) → loud reject v1; self-referencing name → loud reject v1.
- Loud rejects (each with the package name in the message): resolution lands on `.cjs`, or
  package `"type"` is commonjs and only a `"require"` target exists (→ N6); resolved file is
  `.js` while N5 has not landed (→ message says exactly that); `"exports"` uses conditions we
  don't model (`browser`, `development`, ...) with no `import`/`default` fallback.
- Implementation point: extend `nodeShimFile`'s host override (§7.1) — shims first, then
  node_modules, then default resolution. Symlinked/duplicated packages: dedupe by
  `fs.realpathSync(resolvedFileName)` so one package = one SourceFile.
- Tests: fixture packages under `tests/bundler/node_modules_fixtures/` (TS-source packages,
  since N5 hasn't landed), exercising exports-map shapes; loud-reject tests for the CJS and
  conditions cases (`run_bundler_tests.sh` style).

## 9. Phase N5 — untyped JS input (`allowJs`)

Needs its own design doc; constraints fixed now:

- **Step 1 (correct, slow, small):** add `allowJs: true, checkJs: false` to
  `baseCompilerOptions` (exporter.ts:65-86); if ANY non-declaration SourceFile in the bundle
  is JS (`.js`/`.mjs`), force the WHOLE program into the existing untyped mode (`untyped`
  flag, exporter.ts:246-256 — today env-driven via `TSAOT_UNTYPED=1`, becomes also
  input-driven). This is semantically sound by construction (that flag's whole point: stop
  trusting types, keep everything boxed on the dynamic path) and reuses a tested mechanism.
  M2 is reachable with step 1 alone.
- **Step 2 (fast, later):** per-module untyped islands — typed TS modules keep
  specialization; values crossing a typed↔untyped boundary get boxed + (design decision
  needed) boundary guards, because `.d.ts` files of JS packages can lie and a wrong type
  here is a silent-miscompile machine. The boundary-soundness rule is THE design problem of
  step 2; do not start it without the doc.
- Expected perf: untyped modules run the dynamic-dispatch path (flagship profile: dynamic
  property access already 44% — see runtime_perf_plan). Correctness first; shapes+PIC (plan
  P6) is the eventual rescue, not a blocker here.

## 10. Phase N6 — CommonJS interop (static)

Needs its own design doc; policy fixed now:

- Static `require` only: `const x = require("lit")` / `x.y = require("lit")` at module top
  level. Each CJS module compiles to a memoized init function
  (`function __cjs_<id>(): exports` — run-once, cached exports object), called at the
  (compile-time-resolved) require site: this reproduces CJS lazy, cyclic-tolerant evaluation
  inside the eager ESM bundle. `module.exports = ...` reassignment supported;
  ESM importing CJS: default = `module.exports`, named = own enumerable props (node's
  cjs-module-lexer contract, statically approximated). The wrapper also provides
  `__filename`/`__dirname` (compile-time constants of the source path — decide in the design
  doc whether they reflect the original path or a sanitized one; they leak build-machine
  paths into the binary, same concern the pre-publish abs-path scrub (commit 871631a)
  addressed).
- Loud rejects (sloppy-mode policy — we always COMPILE strict; anything whose sloppy
  behavior would diverge must be rejected, not silently strict-ified):
  `with`; assignment to undeclared identifiers (implicit globals); `delete <unqualified id>`;
  bare `this` in a non-method function body (sloppy: globalThis, strict: undefined —
  divergence class); `arguments.callee`; dynamic `require(expr)`; `require.cache/resolve`;
  monkey-patching `module`/`require`. Top-level `this` in CJS = `module.exports` (implement,
  it's common).
- Rule R-D likely breaks here (CJS module wrapper may need IR support) — the design doc must
  enumerate IR changes and their sroa.rs/tests fallout explicitly (CLAUDE.md trap).

## 11. Phase N7 — the big rocks (each = own design doc, unscheduled)

| Item | Contract sketch | Hard dependency |
|---|---|---|
| ArrayBuffer/TypedArray core | new GC kinds (buffer + view w/ offset/len/type); indexed access fast path; `stdlib_coverage.md` currently lists these as out of scope — that entry gets superseded | none (language work) |
| Buffer | `class Buffer extends Uint8Array` in a shim + C codecs (utf8/hex/base64/latin1); unlocks `fs` without encoding, `Buffer.concat`, etc. | TypedArray |
| stream | pure-TS shim over EventEmitter (Readable/Writable, paused+flowing minimal) | events (done in N3), Buffer for binary |
| async fs / net / http | replace the poll loop + `ts_io` internals with libuv behind `-DTSAOT_ENABLE_UV` (keep `ts_io` as the seam, like the curl transport swap promised in async_design.md); JS stays single-threaded, uv threadpool completions marshal back via the loop | N1 loop; Buffer for sockets |
| N-API / V8 C++ shim | moved to their own phase — see §12 (N8) | see §12.4 prerequisites |

## 12. Phase N8 — native addons (`.node`): N-API (N8a), then the V8 C++ shim (N8b)

In scope per user direction (s322). This is the single largest work item in the whole plan;
it gets its own design-doc series before any code. This section fixes the architecture,
records the Bun survey results that define the target API surface, and pins the
prerequisites. Survey sources (fetched 2026-07-09): `oven-sh/bun` tracking issue #4290,
blog series "How Bun supports V8 APIs without using V8" (parts 1–2, 2024), and the current
implementation tree `src/jsc/bindings/v8/` in the bun repo.

### 12.1 Reality check — what the shim is and is not

- **The shim layer must be C++, not C.** A compiled `.node` addon references
  C++-mangled V8 symbols (`_ZN2v86String11NewFromUtf8E…`) and — worse — contains V8
  header code INLINED into the addon binary at its compile time, which reads raw memory
  (Smi tag bits, the map pointer at object offset 0, `InstanceType` at map offset 12).
  So garnet's shim = separate C++ translation units (`runtime/v8shim/*.cc`, compiled with
  clang++ against a vendored copy of the V8 headers), exporting exactly those mangled
  symbols, calling into ts_rt through a small `extern "C"` bridge. ts_rt stays pure C —
  that is compatible with this design, but the C-ness does not remove the hard parts:
  the hard parts are the mangled-ABI surface and the inlined-layout contract, and they are
  identical no matter what language the runtime is written in. What makes the project
  feasible is that Bun proved the façade approach works WITHOUT V8's heap or GC — the
  addon never sees real V8 objects, only V8-shaped handles.
- **AOT twist:** node/Bun are host executables that dlopen addons; garnet's "runtime" is
  the emitted program binary itself. Addon symbol resolution therefore requires linking
  the shim objects into the emitted binary and exporting them (`-rdynamic` /
  `--export-dynamic`), gated so programs that never `require` a `.node` file pay nothing
  (single predictable branch at the require site + link-time exclusion, R-B).
- **Config to match:** node's official V8 build config (pointer compression OFF, sandbox
  OFF) and ONE pinned `NODE_MODULE_VERSION`. Bun does exactly this: a
  `static_assert(REPORTED_NODEJS_ABI_VERSION == NODE_MODULE_VERSION)` at shim build time,
  and a LOUD dlopen-time error naming the found vs required ABI version
  (`src/jsc/bindings/v8/node.cpp:9,63-65`; loud-reject tests exist as
  `test/v8/bad-modules/mismatched_abi_version.cpp`, `no_entrypoint.cpp` — copy both ideas).

### 12.2 N8a — N-API first (own design doc when scheduled)

N-API is a flat, engine-agnostic C ABI (~120 `napi_*` functions, no mangling, no layout
games) and covers the majority of MODERN native addons. It shares all the expensive
plumbing with N8b (dlopen + `process.dlopen`/`node_module_register` registration, `require`
of `.node` files via N6, Buffer/ArrayBuffer interop, error/exception bridging), at a
fraction of N8b's difficulty — so it lands first, and N8b reuses its substrate.
Core mapping: `napi_value` = stable-handle-wrapped tsv (garnet already has stable handles —
the coro-frame scan relies on them, ts_rt.c:9523-9531); `napi_env` = the single runtime;
scopes = a root-registered handle buffer (same GC hook pattern as §5.2). Deferred inside
N8a: `napi_threadsafe_function` + async work (needs the libuv phase).

### 12.3 N8b — the V8 C++ shim: target surface = what Bun has proven

Bun's implemented class inventory (files in `src/jsc/bindings/v8/`, verified 2026-07-09) —
this is our v1 target surface, because it empirically IS the set that real nan-era addons
call:

- **Handles/scopes:** `Local`, `MaybeLocal`, `Maybe`, `HandleScope`,
  `EscapableHandleScope(+Base)` — backed by shim internals `Handle`, `HandleScopeBuffer`,
  `TaggedPointer`.
- **Values:** `Value`, `Primitive`, `Boolean`, `Number`, `String`, `Object`, `Array`,
  `External`, `Data` — backed by fake `Map`s (static, one per instance type, V8 offsets)
  and `Oddball`s (undefined/null/true/false).
- **Calling:** `Function`, `FunctionTemplate`, `FunctionCallbackInfo`, `ObjectTemplate`
  (+ `InternalFieldObject` for internal fields), `Signature`, `Template`.
- **Environment:** `Isolate` (thin: `GetCurrent`, `GetCurrentContext`), `Context` (thin),
  `node.cpp` (module registration + ABI check), `v8_compatibility_assertions.h`
  (static_asserts of struct offsets against REAL V8 headers — steal this verification
  trick wholesale).
- Method-level reality (sampled from the sources): `Value::Is*` predicate family +
  `StrictEquals` + `Uint32Value`; `Object::New/Get/Set/GetInternalField/SetInternalField`;
  `String::NewFromUtf8/NewFromOneByte/Length/Utf8Length/WriteUtf8/Write*V2/IsOneByte/…`;
  `Array::New/Length/Iterate`; `Number::New/Value` (Smi path);
  `FunctionTemplate::New/GetFunction`; `Function::GetName/SetName`.
- **What Bun does NOT have (after ~2 years):** `Persistent`/`Global` handles, `TryCatch`,
  `ArrayBuffer`/TypedArray V8 classes, full UTF-16 strings, heap-number (non-Smi double)
  coverage — all listed unimplemented in issue #4290. Plan the same v1 exclusions, loudly
  rejected at symbol-resolution time (missing symbol → clear dlopen error naming this doc,
  NOT a crash later).

Mechanics to replicate over tsv (from the part-2 blog, layout confirmed against Bun's
`shim/` sources): a handle is `{ TaggedPointer m_toV8Object; ObjectLayout m_object }` where
`ObjectLayout` = `{ TaggedPointer fakeMap; <engine value> }` — for garnet the engine value
is the tsv (or a stable handle to it). Smi ints are encoded directly in the tagged word;
everything else points at the in-handle `ObjectLayout`, whose fake map gives the addon's
inlined code a correct `InstanceType`. The addon's inline reads only ever touch handle
memory + static maps; ALL real data access goes through exported (non-inline) methods,
which unwrap to tsv and call ts_rt. GC: every live `HandleScopeBuffer` is a precise root
set (mark hook pattern of §5.2, old + young); garnet's moving minor GC is safe because
handles carry tsv/stable-handle indirection, not raw body pointers — the same reason the
coro conservative scan is safe today.

### 12.4 Prerequisites and ordering (hard dependencies)

```
N1 loop ─► N6 require (CJS; .node is a require-time artifact)
                │
N7 TypedArray/Buffer (+ node::Buffer C++ helpers — near-universal in real addons)
N7 libuv adoption (addons ALSO import uv_* symbols from the host — export real libuv)
                │
                ▼
        N8a N-API ──► N8b V8 shim (this section)
```

Schedule N8 only after M3. Effort honesty: Bun's shim is multi-engineer-year work and is
STILL a subset; treat every scorecard addon as its own milestone. First targets: a
node-gyp "hello" addon (N8a: N-API; N8b: nan), then one small real package (e.g.
`cpu-features`); issue #4290's package list (node-canvas v2, zeromq, node-pty, gdal-async,
leveldown, kafka clients) is the long-term scoreboard, not the v1 goal.

### 12.5 Testing (extends §13)

Bun-style: a `tests/v8shim/` tree of tiny addon projects compiled with node-gyp against
REAL Node headers of the pinned ABI, each run under node (oracle) and under a garnet-compiled
driver program, stdout-diffed — the existing conformance discipline extended to native code.
Plus negative tests: ABI-version mismatch, missing entrypoint, use of an unimplemented V8
class (must fail with the loud named error, not a segfault). The
`v8_compatibility_assertions.h` static_asserts run at shim build time and are the layout
gate; they re-run whenever the vendored V8 headers or the pinned ABI version change.

## 13. Testing & gates summary

- Every phase: conformance additions under `tests/conformance/basic/node/**` (node is the
  oracle natively — R-E), full `run_conformance.sh all`, unit, `ci_fast.sh`, bundler suite,
  GC-stress, and a flagship A/B whenever shared-path code moved (§5.3, §6.4). Perf budget:
  zero regression on programs that use no node APIs (R-B) — the A/B is the proof, and heavy
  gates/bench runs are scheduled with the user first (working-agreement rule).
- Emit-affecting steps (only §6.2 in N1–N3) coordinate with the byte-parity policy
  (root_batching_design §S5 precedent).
- From M2 on, add `scripts/node_scorecard.sh`: a fixture list of real npm packages (start:
  one zero-dep pure-ESM utility), each compiled + diffed against node; the scorecard count is
  the public progress metric for this whole effort.

## 14. Order and dependencies

```
N1 timers/loop ──► N2 process ──► N3 node: shims (fs/path/os/util/events)  = M1
                                   │
                                   ▼
                        N4 node_modules (ESM) ──► N5 allowJs step 1        = M2
                                                        │
                                                        ▼
                                                  N6 CJS static            = M3
N7 items: TypedArray/Buffer after M1 anytime; libuv/net/http after Buffer; each own doc.
N8 native addons (§12): after M3 + N7 Buffer/libuv — N8a (N-API) before N8b (V8 shim) = M5.
```

N1 is self-contained and is the recommended first session. Nothing in N1–N3 conflicts with
the perf track (runtime_perf_plan) except the two A/B checkpoints and the §6.2 parity event —
sequence those with the user.
