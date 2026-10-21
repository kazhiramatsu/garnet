# Receiver class hints

## Why

tsc-ts (`docs/tsc_ts_native_design.md`) is written for a static subset:
classes with declared fields, few dynamic features. garnet ran it 2.6x
slower than V8, and a profile put 44% of the time in property lookup:
inline cache probes, their misses and the class field lookups behind them.
A field read compiles to a struct offset only when the emitter knows the
receiver's class, which it learned from a parameter's declared class or an
allocation; everything else (a local holding `node.parent`, a narrowed
union, a downcast's result) took the property cache, megamorphic across
the hundreds of AST classes that share `Node`'s fields. Worse, `Node` and
`Type` themselves were unstable, so even their parameters took the cache:
the class extractor read `(node as Identifier).flowNode = f` through
`node`'s type (the cast stripped) and took the write of Identifier's field
for a dynamic property added to `Node`.

## Changes

- **Write receivers** (`class_extract.ts`): a property write's receiver is
  read as its cast says; only a cast through `any` or `unknown` is looked
  through (`(o as any).extra = v` still marks o's class). tsc-ts: 6 classes
  unstable instead of 9 (Node and Type stable).
- **Hints** (`exporter.ts`, `LoadField` / `StoreField` `cls`: class id + 1):
  under the strict type profile, a receiver whose static type at the access
  (narrowed, without null and undefined; a type parameter by its
  constraint) is one stable, non-generic class. The structural flow pass
  (`docs/foreign_receivers_design.md`, "Structural values") makes a class
  unstable when a value that is not one of its instances can be typed as it,
  so the static type is the value's class or an ancestor of it; a cast
  receiver (`(x as C).f`) takes no hint.
- **Emission** (`emit_c.rs`): the analysis's class when it has the field
  (it is flow-insensitive: a downcast's copy keeps the parameter's class),
  else the hint's, at the struct offset of the topmost ancestor declaring
  the field, guarded by what the static type cannot promise:
  - a field the root of the hierarchy declares: at the same offset in every
    class of the hierarchy; the receiver must be an object;
  - a field a leaf class declares: a downcast to the leaf may be wrong
    (`const id = n as Ident; id.text` in V8 reads another node's own
    property, undefined), so the receiver's prototype must be the leaf's;
  - a field an intermediate class declares: no struct access.
  A receiver that fails the guard takes the generic access, which throws
  for null and undefined (`ts_get_checked`) as V8 does.

## Measured

tsc-ts on the TypeScript 6.0.3 compiler project (one thread, emitting):
8.51 s before; 6.26 s with Node and Type stable; 4.96 s with the hints
(43,700 hinted accesses: 29,000 on root fields, 14,300 on leaf fields with
the prototype guard, which costs nothing measurable); node runs the same
source in 3.2-3.4 s. The TypeScript 6.0.3 compiler build is unchanged (its
tsconfig does not select the strict profile).

## Shared prototypes, `instanceof`, casts and records

The next profile showed `instanceof` of imported classes on the dynamic
path (the class's import alias was not resolved: `ts_instanceof_dyn` read
the class value's `prototype` by name), every `new C()` reading the class
value's `prototype` through a property cache, and the leaf guard failing
for most instances: a class value took a copy of the registered prototype
(`ts_make_class_value`), so `CLASS_PROTO[C]` was nobody's prototype.

- **Shared prototypes.** A class whose declaration runs once (not inside a
  function, a loop or another class) gets `AllocClassValue { once }`: its
  value takes the registered prototype itself
  (`ts_make_class_value_once`), so CLASS_PROTO[C] is its instances'
  prototype; a static `new C()` sets it without reading the class value;
  classes evaluated again keep a prototype per evaluation.
- **`instanceof C`** resolves C through an import alias and, for a shared
  prototype, compiles to `instanceof.class:C`: the instance's own prototype
  compared in line, the chain walked otherwise.
- **The binding check.** Neither reads the class value any more, so a use
  before the declaration ran would have succeeded silently (before: a
  TypeError reading `prototype` of undefined). A read from another function
  checks the binding (`binding.check:C`): "Cannot access 'C' before
  initialization", V8's ReferenceError.
- **Casts** (`(n as Ident).text`) take the cast's class: the guards catch a
  wrong downcast, the structural pass a reinterpretation.
- **Records and cells**: a module binding read or written through its scope
  record (or its cell) loaded from a global names the record's class (`cls`
  in every profile: the exporter made the object).
- TSAOT_SHARED_CLASS_PROTO=0, TSAOT_INSTANCEOF_CLASS=0, TSAOT_CAST_HINTS=0
  and TSAOT_CLASS_HINTS=0 restore the old IR (the frozen emitter's gates use
  them).

tsc-ts: 4.96 s -> 3.98 s (shared prototypes, `instanceof`) -> 3.64 s (casts,
records); 49,600 hinted accesses, 16,600 property cache sites left of
22,600.

## Known gaps

- A class-typed parameter trusts its class: a wrong downcast passed to it
  (`f(node as Leaf)` for another kind of node) reads the leaf's struct
  offset (V8: the value's own property or undefined).
- Interface-typed receivers and intermediate classes' fields still take
  the property cache, and polymorphic method calls dispatch through the
  receiver's prototype (`docs/class_index_dispatch_design.md`).
- A deferred read of a lexical binding (`let`, `const`, `class`) before
  its declaration ran (from a function called earlier) reads undefined
  instead of throwing; only the class binding checks above throw.
