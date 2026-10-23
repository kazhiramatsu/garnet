# Hoisted string views for `charCodeAt` loops (session 352, slice Y)

## The cost being removed

`text.charCodeAt(i)` compiles to `ts_str_charcodeat_typed`, which per call
tests the tag, loads the string header, tests the flags (a slice view or a
two-byte text takes another path), bounds-tests the index, and loads the unit.
The three loads are a dependent chain: tag -> header -> data. A scanner's loop
does nothing else, so the chain is the loop's critical path (the
`string_scan` kernel, a lexer over a 20 KB source: 7.26 G instructions).

## The transformation

A loop whose `charCodeAt` receiver is a local the loop never assigns reads
the receiver's view once before the loop, into three scalars:

```c
const char* _sd = NULL; uint32_t _sn = 0u, _sw = 0u;
if (ts_is_str(v)) { ts_strview _hv = ts_str_view_typed(v); _sd = _hv.data; _sn = _hv.len; _sw = (_hv.flags & TS_STR_FLAG_UTF16) ? 1u : 0u; }
```

and each `charCodeAt` in the loop becomes a bounds test and a unit load:

```c
(_sd && i >= 0 && i < (double)_sn) ? (_sw ? <two-byte unit at _sd + 2 i> : (unsigned char)_sd[i])
                                   : ts_str_charcodeat_general(v, i)
```

Three scalars, not a `ts_strview`: the first version kept the 24-byte view and
copied it per read, and in tsc-ts's large functions the compiler spilled it,
so a read cost three stack loads where the per-use path's header loads were
L1 hits (tsc-ts +0.14% instructions with 85 loops hoisted). The scalars stay
in registers, or cost one reload each (tsc-ts -0.1%, within noise).

A string never changes, and the local, used every iteration, keeps the cell
reachable across the loop's allocations, so the view (data pointer, length,
width) stays valid. The general path takes every case the fast test rejects:
an immediate (short) string has no data pointer, an index that is NaN,
negative or past the end, and a receiver that is not a string at all.

### Soundness: what may not be hoisted

- A local the loop assigns (`defs` of the flattened loop, including a
  `catch` variable).
- A captured variable: its reads are explicit cell loads into a fresh local
  per iteration, so that local is in `defs` and nothing is hoisted. A callee
  reassigning the variable through another closure therefore cannot be missed
  (`cap_hoist` probe: a callee inside the loop reassigns the captured string;
  V8 and garnet agree).
- An unboxed or `int` local, or a JSON local: left to the per-use path.

### The cost model

The view read at loop entry costs about one per-use read, so a loop pays for it
only when its iterations are cheap (no `Call`, `CallSpread`, `NewDynamic`,
`Yield`, `Await` in the loop: the unit reads are the loop) or when it reads
the receiver more than once per iteration. Without this gate tsc-ts lost 0.12%
(24.58 -> 24.61 G instructions): 133 loops hoisted, most a per-token loop of
one read and a call, entered millions of times for one or two iterations.

## The receiver that is not a string

The typed entry trusted the `string` annotation: an `any` value behind it that
was a number, `undefined`, `null` or an object reached `ts_str_view_typed`
and crashed (a segfault, not a throw). Both general helpers now route a
non-string receiver to `ts_str_charcodeat_dynamic` (ts_rt.c): `null` and
`undefined` throw V8's property-read TypeError, an object's own or inherited
`charCodeAt` is called with the receiver, and anything else is "not a
function". `strings/charcode_loops` covers all three.

## Measurements

| program | before | after |
|---|---|---|
| `string_scan` kernel, instructions | 7.26 G | 4.07 G (-44%) |
| `string_scan` kernel, cycles | 0.93 G | 0.52 G (-44%) |
| `string_scan` kernel, wall | 0.21 s | 0.12 s |
| tsc-ts one checker, instructions (85 loops hoisted; its scanner reads a `Uint16Array`, so the hot loops do not qualify) | 24.61 G | 24.59 G (-0.1%) |
| tsc-ts one checker, cycles | 5.91 G | 5.87 G (-0.7%) |

Outputs byte-identical (`out_ab.sh`).

Knob: `TSAOT_STR_HOIST=0` restores the per-use path (the parity oracle's output).
