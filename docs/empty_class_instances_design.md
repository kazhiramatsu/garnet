# Field-less class instances as plain shaped objects

## Problem

A class instance is a *sized* cell: the registered struct fields follow the
header, and the cell starts in the dictionary shape so a class descriptor can
resolve a field before the named-property vector. A class with no fields at
all — the compiler's `const SymbolLinks = class implements SymbolLinks {
declare _symbolLinksBrand: any }`, instantiated once per symbol and then
populated lazily (`links.type = ...`, `links.target = ...`, dozens of
optional members) — got the same treatment: a header-only cell in the
dictionary shape. Every later addition was therefore a slow addition (the
addition cache refuses dictionary receivers: 1.74M slow additions per
compile), every read missed the inline caches and went out of line through
the class registry and the dictionary probe (part of the 11.7M registry
lookups and 27M `prop_find` calls). Kernel `benchmarks/patterns/
links_objects.ts` (the pattern in isolation): native 1,388 ms against Node
152 ms, 9.1x, the worst kernel measured, with four fifths of its samples in
`prop_ic_probe`, `ts_get_pic_checked`, `prop_find`, `class_field_lookup`
and their helpers.

## `declare` fields

The exporter's class extraction counted every property declaration as a
field, including `declare x: T`, which is an ambient declaration with no
run-time property (V8 erases it). So `SymbolLinks` actually had one struct
field, `_symbolLinksBrand`, present as an own `undefined` property on every
instance (`Object.keys`, `in` and `hasOwnProperty` disagreed with V8), and
the class was sized. Ambient property declarations are now skipped (no
struct slot, no key; a computed ambient member is not installed either), so
the class is field-less and the rule below applies to it.

## Design

A field-less class instance is an ordinary shaped object. `ts_new_sized`
with the header-only size returns `ts_new_object_impl` with
`TS_EMPTY_CLASS_SLOTS` (8) in-object slots and the empty shape — the
callers (the generated allocation sites and `ts_construct`) set the
prototype afterwards as they always did. `ts_construct` sizes the instance
of a field-less class from the slack learned on the constructor value
(`inst_slots`, as for plain function constructors), never below 8. Nothing
else changes: `ts_obj_is_sized` is already false for a header-only cell,
the class registry still answers "no struct field" for the prototype, and
subclasses with fields keep their sized layout. The additions now take the
addition cache and shape transitions, reads and writes the inline caches,
and the objects of one class share shapes.

`TSAOT_EMPTY_CLASS_PLAIN=0` (runtime environment) keeps the dictionary cell.

## Verification

Fixture `classes/empty_class_dynamic_props` (brand-only class expression,
empty declaration, empty and non-empty subclasses, dynamic `new` through a
function value, key order and JSON, `instanceof`/`constructor`/prototype
identity, `in`/`hasOwnProperty`, deletion and re-addition, freezing, methods
and accessors on the prototype reading the dynamic properties, 20k
instances with cross references), GC stress, the compiler A/B.
