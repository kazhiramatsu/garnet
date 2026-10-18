# Direct-call entry points (roadmap track C, item 1)

## Problem

Every generated function has one entry, `static tsv fn_X(tsv* args, int
nargs)`. A direct call therefore stores its arguments into a stack array, its
callee's captured scope records into a second array, publishes that array
through the global environment register `g_ts_cur_env`, and calls; the callee
reads the register, copies each record out of it, tests `nargs` once per
parameter and copies the arguments out of the array. After the Session 350
slices the compiler makes 27,461 such environment-passing direct calls (plus
the plain ones), and the hottest generated functions are small leaves such as
`getObjectFlags` (one record, one argument, two property reads) where this
traffic is a large share of the function.

## Design

Every eligible function gets a second entry whose parameters are C
parameters, cells first, then the arguments, each in the representation the
body already uses for that parameter:

```c
static tsv fn_1590_getObjectFlags_d(tsv _p0, tsv _p1);          /* body */
static tsv fn_1590_getObjectFlags(tsv* args, int nargs){         /* forwarder */
  tsv* _env = g_ts_cur_env;
  return fn_1590_getObjectFlags_d(_env[0], (nargs > 0 ? args[0] : TS_UNDEFINED));
}
```

- Parameter kinds come from the same classification the body uses
  (`unboxed_candidates` and the numeric analysis): `long long` for an integer
  local, `double` for an unboxed numeric local, `tsv` otherwise. The
  signature table is computed once before emission; the body entry asserts
  that its own classification agrees.
- A direct call site (`CalleeRef::Direct`, after the existing i64/f64 clone
  fast paths) passes each argument converted to the callee's kind: a boxed
  parameter takes the boxed view of the local, a `double` parameter the
  numeric view (`ts_to_num` of a boxed local, exactly what the generic
  prologue did), a `long long` parameter the truncated numeric view. A
  missing argument is `TS_UNDEFINED`, `0.0` or `0` — the values the generic
  prologue left in place when `nargs` was short. Extra arguments are dropped
  (the callee cannot observe them: functions that read `arguments` keep the
  generic entry only).
- The generic entry becomes a forwarder: it reads the environment register
  and the argument array once and calls the body entry. Function values
  (closures, tables, `ts_call`) keep using it, so the runtime is unchanged.
- Not eligible: async and generator functions (coroutine frames copy
  parameters themselves), rest parameters, bodies that read
  `arguments.length`. Spread calls and devirtualized call sets keep the
  array convention.
- `TSAOT_DIRECT_ENTRY=0` restores the single generic entry; the parity
  oracle runs with it.

## GC and exceptions

Arguments were never scanned in the array (the caller's frame slots hold
them); passing them in registers changes nothing for the collector. The body
entry copies every parameter into its locals or frame slots in the prologue,
as the generic entry did from the array, so a `longjmp` back into the
function never reads a parameter register.

## Expected effect

Per direct call: no argument array stores and loads, no environment array,
no global register store and load, no `nargs` tests. Measured by the
compiler A/B against the direct-nested-call build.
