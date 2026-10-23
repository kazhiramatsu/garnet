# Field types by store safety (slice W, session 352)

Exporter. A class field gets a scalar representation (`number`, `int32`;
docs/int32_fields_design.md) when every instantiation agrees on its type
(`recordInstantiationFieldTypes`, `uniformFieldTypes`). Until this slice the
recording also required the whole class declaration to be free of unchecked
type syntax, `classTypeOptimizationSafe`: one `as`, `!`, `any` or `unknown`
anywhere in the class body, and every field of the class, and of the classes
above it, stayed a boxed value.

## Finding

tsc-ts's `Type` (`checker-types.ts`) has `flags: TypeFlags`, `objectFlags:
ObjectFlags`, `id: number`, but its accessors downcast `this` (`(this as
unknown as IndexType).target`), so the class was unsafe and `flags` was read
as a boxed value, `ts_to_num` and ToInt32 at every flag test: the checker's
`isSimpleTypeRelatedToWorker` began with two such reads. Only 158 of the
compiler's 812 classes had any typed field; `Checker` (250 fields), `Type`,
`SymbolLinks`, `Binder` had none.

## Change

A typed field is mis-set only by a store, so the safety test moves from the
class body to the stores. `collectUnsafeFieldStores` walks every source file
once and marks:

- a field declaration (a property declaration or a parameter property) as
  unsafe when some assignment, plain or compound, to `x.f` has a value with
  unchecked type syntax or an `any`/`unknown` type, when `x.f` is a
  destructuring target, or when `delete x.f` appears;
- a class declaration as stored into dynamically when an element store
  `x[k] = v` or `Object.assign(x, ...)` has `x` of that class (the receiver's
  class before any cast, so `(x as any)[k] = v` counts against x's class).

The recording then boxes a field whose declaration is unsafe, and keeps every
field of a dynamically stored class, and of the classes above it, boxed, as
the class-wide rule did. Reads through casts no longer matter. Stores reaching
an int32 field with a non-integer still throw (`ts_int32_field_value`);
`classTypeOptimizationSafe` stays in use for generic class specialization.
Fixture `classes/field_store_safety`.
