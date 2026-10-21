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

## Known gaps

- A class-typed parameter trusts its class: a wrong downcast passed to it
  (`f(node as Leaf)` for another kind of node) reads the leaf's struct
  offset (V8: the value's own property or undefined).
- Interface-typed receivers, cast receivers and intermediate classes'
  fields still take the property cache.
