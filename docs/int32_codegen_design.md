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

## Bounded bitwise results and absorbed negative zeros (Session 353)

The Q8_0 dot product of the GGUF llama program (`benchmarks/llama2/
llama_gguf.ts`), `isum = (isum + a * b) | 0` over int8 values, stayed a
double chain: the numeric analysis (`infer_numeric_analysis`) gave a
bitwise result no range, so the product of two `| 0` results was an
unbounded int32 times an unbounded int32 (2^62, not provably within 2^53)
and fell to double; and even with ranges, a product of a value that may be
zero and a value that may be negative is `-0` in JS, which an integer
cannot hold. Two rules:

- **Ranges from the operator itself** (sound for any operand): `& c` with a
  non-negative constant mask is [0, c]; `>> k` for a constant k in 1..31 is
  [-2^(31-k), 2^(31-k) - 1]; `>>> k` is [0, 2^(32-k) - 1]; `x | 0` keeps a
  range of x that lies within int32 (ToInt32 is the identity on it); `^`,
  `<<` and the other forms are the int32 fact as before. So `(v << 24) >> 24`
  is the int8 range, `v & 255` the uint8 range, and the quantized kernels
  sign-extend their loads by shifts to say so. (A range from the typed
  array's element kind would need the annotation trusted; the shifts cost
  nothing and need no trust.)
- **A product whose negative zero every use absorbs** is an integer: when
  the ranges make the product exact but a zero times a negative is possible,
  the product is still i64-safe if each of its uses is `+` or `-` with an
  int32-by-definition local or an integer constant on the other side (a value
  that is never -0, so the sum is +0), a bitwise operand (ToInt32(-0) is 0) or
  a comparison; a copy, a store, a return, a call argument or any other use
  could observe the sign and keeps the product a double. A local is int32 by
  definition when each of its definitions is a bitwise operator, `~`, an
  integer constant within int32 or a copy of such a local (a fixpoint, so the
  accumulator `let isum = 0; ... isum = (isum + p) | 0` qualifies). The check
  walks the flattened body and skips the container instructions, whose
  children it visits on their own.

Measured: TinyLlama-1.1B-Chat Q8_0 under garnet 0.5 -> 4.1 tokens/s
(Node 2.2); the inner loop is `d80 = d66 * d73; d81 = d54 + d80; d83 =
ToInt32(d81 | 0)` in `long long`. Fixture `numbers/small_int_products`: int8
and uint8 dot products, `h * 31 + c` hashes, FNV with `Math.imul`, nibble
products, the observable negative zero (printed, divided, stringified,
copied, stored) beside the absorbed one, products past 2^53 that stay
doubles, shifted and masked products at the int32 limits.

Next: the chain is `long long`; a `| 0`-terminated chain of int32-by-
definition values could be emitted in `int32_t` with wrapping arithmetic
(a ring homomorphism, the same final value), which lets the C compiler
vectorize the dot product with 32-bit lanes.
