# Known coverage gaps (found by the conformance harness)

These are TypeScript features the exporter/codegen does not yet support. The
conformance harness surfaces them as FAIL/UNSUPPORTED. Tracked here so the basic
tier stays green (regression net) while the exhaustive tier documents the gaps.

- `**` exponentiation operator (`AsteriskAsteriskToken`) — use `Math.pow` for now.
- `.toFixed()` / number methods on a numeric expression result (e.g. `(a/b).toFixed(4)`)
  — number-receiver method dispatch not wired.
- (more added as the exhaustive suite grows)

## Found in exhaustive sweep (session 2)

(All items in this section now FIXED — listed for historical context. The
exhaustive tier passes 37/37 as of session 4.)

- ~~**Inliner local-collision with Math.* of an inlined field expression**~~
  FIXED (session 4): replaced the `other.clone()` fallthrough in
  `inline_callee` with an exhaustive `remap_inst_operands` over every `Inst`
  variant (including recursive remap into `If`/`Loop`/`TryCatch` bodies).
  See `docs/inliner_and_loop_let_capture.md`.
- ~~**switch case fall-through**~~ FIXED (session 3): empty-bodied case
  clauses are OR'd via short-circuit `If` (BinOp has no `||` codegen).
- ~~**`continue` in a for-loop**~~ FIXED (session 3): moved the incrementor
  to the start of `cond_body`, guarded by a `first` flag. Loop kind `"forc"`
  uses a real C `continue` jumping to `cond_body`.
- ~~**bitwise operators**~~ FIXED (session 3): `& | ^ << >> >>>`, `**`, and
  `~` with JS ToInt32/ToUint32 (`ts_to_int32`/`ts_to_uint32` runtime helpers).
- ~~**variadic array push**~~ FIXED (session 3): `array.push` codegen loops
  over all args.
- ~~**`for...of` over `map.keys()`/`map.values()`**~~ FIXED (session 3):
  builtin-call expressions returning an array prefer the index loop over
  the dynamic iterator protocol.
- ~~**`for...of` over a string**~~ FIXED (session 3): when the receiver is
  statically a string, use `GenericLen` + `string.charAt` for char iteration.
- ~~**closure capture of a loop `let i`**~~ FIXED (session 4): per-iteration
  cell allocation in `cond_body`, seeded from the previous iteration's cell
  value. See `docs/inliner_and_loop_let_capture.md` for the spec-aligned
  ordering (update runs on the NEXT iteration's cell, so closures captured
  in iter-N retain iter-N's value).
- ~~**higher-order `compose(f,g)(x)`**~~ FIXED (session 3): captured parameter
  values are now stored into their cells at function entry.
- ~~**parseInt/parseFloat as bare calls**~~ FIXED (session 3): added
  `isNaN`/`isFinite` globals, plus `NaN`/`Infinity` identifiers via the new
  `ConstVal::NaN`/`PosInf`/`NegInf` (NaN isn't valid JSON, so a dedicated
  tag is required).

## Additional fixes (session 4) — found while implementing the above

- **SROA scalarized non-numeric fields as `Primitive` doubles**: previously
  `class Stack { items: number[] = [] }` had its `items` field reduced to a
  double, corrupting the array pointer. Fixed by selecting `Reference` vs
  `Primitive` based on `numeric_fields.contains(&(cls, f))`.
- **`.push(x)` early-path didn't check receiver kind**: any `.push(x)` (one
  arg) was lowered to `ArrayPush`, including methods on user classes named
  `push`. Fixed with a `builtinReceiverKind === "array"` guard.
- **`numeric_fields` didn't inherit through the parent chain**: caught as a
  perf regression in `inherit_sroa_kernel` (192ms vs 130ms budget). Fixed
  by propagating numeric tags down to all descendants.

## FIXED (session 2)
- number-receiver methods `.toFixed()/.toString(radix)/.toPrecision()` — added
  number builtin kind + runtime ts_number_to_fixed/to_string_radix/to_precision.
- string `lastIndexOf` — added ts_str_lastindexof.
- **unary minus of a float truncated to int** (`-3.14` -> -3): infer_int_locals now
  handles UnOp (result int only if operand int). This fixed Math.abs(-floatvar) etc.
