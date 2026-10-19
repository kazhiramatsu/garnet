# int32 locals for bitwise-only uses

Implemented in Session 350 (slice `x28`); emitter only
(`analyzer/src/emit_c.rs`). Knob `TSAOT_INT32_USES=0` keeps the per-use
conversion (the parity oracle sets it).

## Finding

The checker's flag idiom reads a number once and tests it against many
constants: `isSimpleTypeRelatedTo` (111 self samples in the `x25` profile,
the hottest generated function) begins with `const s = source.flags; const
t = target.flags;` and then applies about twenty-five tests of the form
`t & TypeFlags.X`. The emitter already keeps the results of bitwise
operators in int locals and has an integer fast path when both operands
are int locals, but `s` and `t` are unboxed doubles (a property read is
an arbitrary number), so every test rendered
`ts_to_int32((double)d9) & ts_to_int32((double)d13)`: a range check, two
conversions and a compare per test, fifty conversions per call.

## Change

An unboxed, non-parameter local whose every use is an operand of `& | ^
<< >> >>>` or `~`, or a copy into another such local (a fixpoint over
copies), holds ToInt32 of its value from the definition on. ToInt32 is a
function of the value, so applying it once at each definition and casting
at the uses gives exactly the per-use semantics: NaN and infinities
become 0, fractions truncate toward zero, out-of-range values wrap. The
local stays a double, so every definition path keeps its type and only
the conversion moves:

- definitions: `set_num` and `set_val` emit `(double)ts_to_int32(...)`;
  the direct-entry call results and the string-sum copy route through
  them; a copy between two such locals is a plain copy;
- uses: a bitwise operand renders `(int32_t)d`; an int local operand
  renders `(int32_t)(uint32_t)d` (an integer wraps through `uint32`
  instead of a double round trip); a shift count renders the masked
  `uint32` of the same cast; `~` likewise.

Parameters are excluded (their bindings bypass the setters), as are json
and int locals. The analysis walks nested bodies (`If`, `Loop`,
`TryCatch`) and delegates every other instruction kind to the emitter's
operand enumeration, so an unforeseen use disqualifies the local.

## Verification

Fixture `operators/bitwise_only_locals`: a flag-classifying function over
integers, negatives, fractions, NaN, infinities, values at and beyond the
int32 and uint32 limits, huge magnitudes, negative zero and shift counts
around 32; copies between converted locals, a conditional reassignment, a
loop reassigning the local with fractions, parameters, chains of bitwise
results, call results, and a local used both bitwise and in comparisons
(the unchanged path). Identical to V8. The emitted code of the fixture
shows the definition conversion and the cast operands; the legacy knob
reproduces the previous output.

## Results

Generated compiler (`x28`): `ts_to_int32` calls 8,311 → 4,913,
`isSimpleTypeRelatedTo` 100 → 3, 3,699 cast operands. Compiler A/B against
`x26` (alternating three runs, outputs validated, diagnostics zero), three
times on a loaded machine: 5.690 → 5.759 s, 5.680 → 5.636 s, 5.717 → 5.620 s
median wall; about −1% once the outlier pair of the first run is set aside.
