# Int32 fields: enum-typed class fields as integers

Session 352. The corrected profile of tsc-ts
(`docs/single_thread_vs_scriptc.md`, "The profile, corrected") puts about
9% of the generated code's samples in `fmov` (a number boxed or unboxed
between the integer and floating-point files) and in `fjcvtzs`/`scvtf`
(int32 conversions). tsc-ts's hottest fields are enums: `Node.kind`
(`SyntaxKind`), `Node.flags` (`NodeFlags`), `Type.flags` (`TypeFlags`),
`ObjectType.objectFlags`, `Symbol.flags`, `CheckFlags`. A monomorphized
numeric field is an unboxed double today, so `switch (node.kind)` loads a
double, converts it to int32 with an exactness test (`fjcvtzs`, `scvtf`,
`fcmp`, `csel`) and dispatches; `flags & NodeFlags.X` converts twice.
scriptc stores an enum as an `int` and dispatches on a load.

## The design

- **The tag.** The exporter records a class field's representation from
  the instance types at its `new` sites (`recordInstantiationFieldTypes`,
  tag `number` when `classify(ft)` is a primitive number type). A new tag
  `int32`: the field's type at every instantiation is a numeric enum whose
  members are all int32 literals, or a union of int32 literal types (and
  `boolean`-free). `uniformFieldTypes` passes `int32` through when every
  site agrees; a site disagreeing (`number` at one, `int32` at another)
  falls back to `number`, as today a `tsv` at any site boxes the field.
  Only under the strict profile, like `number`; the parity oracle exports
  without it and never sees the tag.
- **The slot.** The struct member is `long long f{id}` (an 8-byte slot:
  the class descriptor's widths and the object's extent are unchanged, the
  collector's field initialization (`!numeric` slots to undefined) and its
  skipping of numeric slots are unchanged). A later slice may pack to four
  bytes.
- **Reads.** A `LoadField` of an int32 field into a local the emitter types
  as an integer (`infer_int_locals` admits such loads) is one load; into a
  double local, a load and `scvtf`. The guarded form stays:
  `(guard) ? ts_to_int32_checked(slow) : struct->f`, where the slow path's
  boxed value is converted with the same exactness rule as a store.
- **Stores.** From an integer local, one store. From a double or a boxed
  value, `ts_int32_field_store(d)`: exact int32 or a TypeError ("an
  integer-typed field receives a non-integer"), a loud reject in the spirit
  of the typed profile (the annotation says the field holds an enum member;
  a program storing 1.5 through an `any` cast is refused, never truncated
  silently). The generic paths (`struct_field_set` through the class
  descriptor, `ts_set` on a sized instance) apply the same rule; the
  generic read (`struct_field_get`) boxes `(double)` of the integer.
- **The descriptor.** `ts_class_field.numeric` becomes a kind: 0 boxed, 1
  double, 2 int32. The runtime's consumers (`struct_field_get`,
  `struct_field_set`, `class_reg_field_value`, the width rule, the
  initialization) switch on it.
- **SROA.** `sroa.rs` treats `int32` as it treats `number` (an unboxed
  scalar; the replaced object never exists at runtime).
- **Knob.** `TSAOT_INT_FIELDS=0` reads the tag as `number` (the emitter's
  current representation), for A/B and for the oracle.

## What it should buy

The switch dispatch on `kind` loses its four conversion instructions and
its `fmov`; flag tests become integer `and`s on a loaded word; stores of
enum constants become integer stores. Measured by the kernels
(`class_nodes`, `switch_dispatch`, `flags_truthy`) and tsc-ts's instruction
count; expected a few percent of the compile.

## Known deviations kept

A monomorphized field reads as 0 before its first assignment (V8:
undefined); for an int32 field the same (`docs/TODO.md`, the known items
of Session 350).

## As built (Session 352)

- Exporter: `isInt32ValuedType(t)` (a numeric enum whose members are all
  int32 constants, a member of one, or a union of int32 literal types) makes
  the tag `int32` in `recordInstantiationFieldTypes`; `uniformFieldTypes`
  passes it through, and a field tagged `int32` at some sites and `number`
  at others is a `number`.
- Analyzer: `int32_field(c, field, classes)` beside `numeric_field` (which
  now counts `int32` as numeric: an unboxed slot); the struct member is
  `long long`; the class descriptor's `numeric` is a kind (0 boxed, 1
  double, 2 integer); a `LoadField` of an integer slot is an int32 fact for
  the numeric analysis (`int32_field_loads`, by the receiver's class hint),
  so the destination becomes an integer local when its uses allow, else the
  value widens to a double; a `StoreField` from an integer local stores it,
  from anything else `ts_int32_field_value` checks and converts;
  `sroa.rs` treats the tag as a scalar. `TSAOT_INT_FIELDS=0` keeps doubles.
- Runtime: `struct_field_get`/`struct_field_set`/`class_reg_field_value`
  read and write kind 2 (a non-integer store throws
  "an integer-typed field receives <value>", `ts_throw_int32_field`); the
  collector already skipped non-zero kinds; the field initialization and
  the width rule are unchanged (8-byte slots).
- Fixture `classes/enum_int_fields` (V8 output identical, plain and
  strict). Kernel `class_enum_fields`: 3.31 -> 3.02 G instructions (scriptc
  1.67); `class_nodes` unchanged (its fields are `number`s, as tsc-ts's
  `pos`, `end`, `id` are).

## Result

tsc-ts, one thread, the TypeScript compiler project, six interleaved pairs
against the previous build (outputs identical): instructions 28.29 ->
27.28 G (0.9645), cycles 6.43 -> 6.29 G (0.978), wall 1.49 -> 1.46 s.
Gates: parity (381 identical), selfconf, unit, bundler 43/43, conformance
540/540 plain and strict, 537/537 under protect mode, GC stress.

## Store-proven fields (Session 353)

A `number`-tagged class field (a monomorphized double) whose every static
store in the program is an integer value is an integer slot too: tsc-ts's
`Node.pos`, `Node.end`, `Node.id`, `Type.id`, `Signature.id`, the scanner's
positions, the counters. The emitter's `infer_int_store_fields` runs once
before emission (after `infer_indirect_funcs`):

- **Candidates**: the number-tagged fields of stable declaring classes (the
  classes the emitter accesses as structs; an unstable class's accesses are
  all dynamic, so no static store could refute its fields).
- **The fixpoint is optimistic**: every candidate starts as an integer slot;
  the program's facts are computed with that (`infer_program_param_facts`,
  the i64 returns, and per function `infer_numeric_analysis`, whose loads of
  a candidate are `NumFact::integer_value()`: an integer in the safe range
  of unknown sign, as opposed to the int32 range of an enum field); a
  `StoreField` whose value is neither an integer local nor an integer fact
  refutes its field; the rounds repeat until no refutation (tsc-ts: four
  rounds). A store refutes through every class it can be about: the
  receiver local's class (`local_class_map`, `this` in a method or a
  constructor by `func_class`) and the instruction's hint. Only live
  functions refute: a function called directly or through a resolved set, a
  value (`indirect`), a method, an export or a module initializer; the
  inliner keeps the body of an inlined callee, whose stores never run (the
  fixture's `shift` refuted `pos` from a body no one called).
- **Representation**: the slot is `long long` like an enum field, kind 3 in
  the class descriptor (`field_int_kind`: 0 boxed or double, 2 an int32
  slot, 3 a store-proven slot). The layout (`emit_field_chain`), the
  descriptor and every access decide through `field_int_kind`, so they
  agree; the first version decided the layout by the tag alone and the
  descriptor by the proof, and a dynamic store then wrote integer bits into
  a double member (`nextAutoGenerateId` read as 4607182418800017400).
- **Stores**: from an integer local one store; from a double or a boxed
  value `ts_int_field_value_k(d, key)`: any integer within 2^53, else a
  TypeError naming the field ("the integer-typed field 'pos' receives
  2.5"); the enum rule is `ts_int32_field_value_k` (an exact int32). The
  dynamic paths (`struct_field_set`, kind 3) apply the same rule.
- **The deviation**: every static store was proven integral, but a store
  through an `any`-typed receiver (`(n as any).pos = 2.5`) or another
  dynamic route is checked at run time and refused with the TypeError where
  V8 stores the fraction. It is loud, it needs a store the types do not
  vouch for, and the knob removes it. Listed in the README's known
  differences.
- **Knobs and logs**: `TSAOT_INT_STORE_FIELDS=0` (no candidates; the
  parity oracle exports without the strict profile and never sees number
  tags), `TSAOT_INT_STORE_FIELDS_LOG=1` (the proven fields, the
  refutations with the function and local, the rounds' times), `=2` (every
  examined store with its fact, each relevant function's parameter facts),
  `TSAOT_PARAM_FACTS_LOG=1` (the parameter-fact solver's contributions).

### Typed capture-context fields

A captured variable lives in a field of its owner's capture-context class
(`__ctx_<owner>`, docs/capture_contexts_design.md); those fields were
boxed, so a module-level counter (`let nextSymbolId = 0`) boxed and unboxed
at every use and could prove nothing. The exporter now tags such a field
`number` (an enum: `int32`) when the variable's declared type classifies as
a number, every store the checker vouches for (`collectUnsafeFieldStores`
also marks variables: an assignment or a declaration initializer with a
cast, a non-null assertion or an `any`/`unknown` type, a destructuring
target, a `for-in`/`for-of` target that is not a declaration), and the
strict profile is on. The field name carries the variable's name after the
binding id (`c5337_nextAutoGenerateId`) for diagnostics. A number-typed
local assigned from an `any` reads as NaN already (README, known
differences); an integer context field refuses it loudly instead.
`TSAOT_TYPED_CTX_FIELDS=0` keeps the boxed cells.

### The parameter-fact solver's cache

`infer_program_param_facts` re-analyzed every caller in each of its eight
iterations (9.5 s of tsc-ts's 41 s analysis). A caller's contributions
(target, parameter index, the argument's fact) depend only on its own
parameter facts and its integer field loads, so they are cached per caller
(thread-local) and reused when neither changed, across the iterations and
across the store-proven pass's rounds: 9.5 s became 1.4 s for the first
computation and 0.3-0.4 s for each later one. tsc-ts's analysis: 41 s
before, 31 s with the cache, 36 s with the pass.

### Results

- tsc-ts: 262 of 457 candidates proven (the number-tagged fields of stable
  classes, context fields included): `Node.pos`, `Node.end`, `Node.id`,
  `Type.id`, `Signature.id`, `Scanner.end`, `Scanner.tokenStart`, the
  checker's counters and depths, the module-level counters. `Symbol.id`
  stays a double: `takeSymbolId` returns `(... ? ++n : chunk()) | 0`, whose
  integer return the i64 analysis does not establish (a conditional with a
  call), so `symbol.id = takeSymbolId()` has no fact. Constructor
  parameters have no facts either (`new` sites make a constructor
  `indirect`), so a field set from a constructor parameter is proven only
  when the parameter is an integer local by other means.
- One checker, plain builds, three runs: instructions 0.9927, cycles 0.9950,
  outputs identical at one and at the default checkers. Kernels
  (instructions): `class_nodes` 4.34 -> 3.80 G, `closures_env` 4.77 ->
  4.41 G, `tree_recursion` and `class_enum_fields` unchanged.
- Fixture `classes/int_store_fields` (V8 output identical, plain and
  strict): positions, ids and counters as integer slots, a field with one
  fractional store kept a double, closure and module-level counters, an
  enum-typed variable, a captured loop variable and parameter, 2^31 and
  2^40, JSON numbers entering through `| 0`.

### Found by the strict conformance run

- `types/generic_class_callbacks`: a specialization clone's method
  (`Observable$number.map`) runs on an instance of another clone or of the
  base class (`new Observable(f(this.value))` creates the `$U` clone; the
  result's static type dispatches `.map` to the `$number` clone), and reads
  the other layout's slot. A double slot happened to read the boxed number's
  bits as the double it is; an integer slot read 2.0 as 4611686018427388000.
  The pass excludes clones (a `$` in the class name) until the dispatch is
  guarded; the underlying hole (a string in such a slot reads garbage) is
  recorded in the progress log.
- `classes/grafted_methods`: a method grafted onto another class reads an
  integer field through a `this` that lacks it: `undefined`, which the
  integer local cannot hold (`(long long)NaN` is 0 where V8 computes NaN).
  `int32_field_loads` gives no integer facts unless the program has closed
  receivers, and a field read into a double local takes the slow path's value
  as it is (`ts_to_num(slow)`), so a foreign receiver reads NaN as a double
  field's does. An integer local that does read a foreign `undefined` (an
  `any` cast of a wrong object in a closed program) reads 0: the typed
  profile's trust, as for a double field read before assignment.
