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
