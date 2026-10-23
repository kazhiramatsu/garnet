# int32 code generation (slice O, session 352)

Emitter and runtime. Knob `TSAOT_INT32_CODEGEN=0` keeps the earlier forms (the
parity oracle sets it); `Math.imul` in line is slice M's `TSAOT_IMUL_INLINE`.

## Finding

The scanner kernel `benchmarks/patterns/scanner_ident.ts` (a Uint16Array text,
an ASCII identifier predicate and an FNV-1a step per code unit, as tsc-ts's
scanner hashes identifiers) ran at 2.06x scriptc's instructions (1.92 against
0.93 G) and 1.83x its time. Its machine code showed about 40 instructions per
code unit, of which:

- `Math.imul`'s operands went through `ts_to_int32(double)`: for an int local
  that is a widening `scvtf` and an `fjcvtzs` (two instructions and the FP
  latency on the hash's loop-carried chain), and for the constant 16777619 a
  `fmov` and an `fjcvtzs` every iteration, since `__builtin_arm_jcvt` is not
  constant-folded.
- The sign extension of a bitwise result, `(t >= 0x80000000u) ? (long long)t
  - 0x100000000LL : (long long)t`, compiled to `orr`, `cmp`, `csel` (three
  instructions) at every `| 0`, including the loop counter's.
- A Uint16 element was loaded into an FP register (`ldr h0`, `ucvtf`) and
  converted back (`fjcvtzs`) for the `| 0` that consumes it; the int32-use
  local that receives it is a double, so its uses cast again.

## Change

1. `Math.imul`'s operands are taken as the bitwise operators take theirs
   (`bitwise_operand`): a cast for an int or int32-use local, a constant folds,
   the runtime conversion otherwise.
2. The sign extension is written `(long long)(t ^ 0x80000000u) - 0x80000000LL`,
   which the compiler folds to one `sxtw`.
3. An int32-use local (docs/int32_use_locals_design.md: a local whose every use
   is a bitwise operand) is stored as `long long`, holding ToInt32 of its value
   as before; its definitions drop the widening cast and its uses cast from the
   integer. The coroutine frame field follows.
4. A typed-array element of an integer kind (Int8 .. Uint32) read with an int
   index into an int32-use local is loaded as an int32 (`ts_ta_try_load_i32`,
   Uint32 wrapping as ToInt32 does); the generic slow path converts once. The
   slow path of a numeric destination now goes through ToNumber
   (`ts_number_coerce`) rather than the raw reinterpretation: a non-view
   receiver (an `any` cast) whose element is the string "8" reads 8, as
   `ToInt32(ToNumber(x))` says, where it read the string's bits before
   (`arrays/typed_array_loops` found it).

## Slice P: the receiver's test hoisted out of the loop

A loop's element reads, writes and `length` reads of a typed-array receiver
that the loop never assigns (no instruction in the loop defines the local, no
catch binds it) read the receiver's view test and length once before the loop
(`ts_typedarray* _tah = ts_ta_as(v, elem); uint32_t _tal = _tah ? _tah->length
: 0`); each access is then a bounds test against `_tal` and an element load
through `_tah->data`. The cell pointer is used every iteration, so the view
stays reachable to the conservative scan (a hoisted data pointer alone would
not keep it alive). A typed array's length and data never change after
construction (no resizable buffers or detaching), so the hoisted values hold;
an own `length` property defined on the view (`Object.defineProperty`) shadows
the internal length, and the hoisted length read keeps `ts_ta_try_length`'s
test of an empty own-property map per read. Knob `TSAOT_TA_HOIST=0`.

The scanner kernel: 1.92 G -> 1.44 G (slice O) -> 1.14 G instructions (slice
P), against scriptc's 0.93 G; wall 110 -> 60 -> 40 ms against scriptc's 50 ms.

Semantics are unchanged: every form computes the same ToInt32 value, and the
fixture `numbers/int32_codegen` covers the integer kinds, Uint32 above 2^31, an
index out of range, non-numeric `Math.imul` operands and the int32 boundaries.
