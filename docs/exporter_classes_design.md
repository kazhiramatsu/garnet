# Exporter ↔ class/devirt wiring

The exporter now extracts classes, lifts method bodies, and emits method calls as
`CalleeRef::Method` plus a `classes` table — feeding the devirt pass end to end.

## What was added to exporter.ts
1. **Class setup** (`setupClasses`): runs `ClassExtractor` (class_extract.ts),
   records `classSymToId`, and assigns a FunctionId to every method body, recorded
   for lifting. Runs before free-variable analysis so method bodies take part in
   capture analysis like any other function.
2. **Method lifting** (`lowerMethod` → `lowerFunctionLike(..., thisParam=true)`):
   `this` becomes **param 0** (matching the Call `recv` actual at index 0), then
   captured cells, then real params. `this` and `this.x` lower to the this-local
   and `LoadField`/`StoreField` on it.
3. **Method-call lowering**: `o.m(...)` where `o`'s static type is a known class
   and `m` is one of its methods emits
   `CalleeRef::Method { recvClass, method=internName(m), recvStable }`, with
   `recvStable=recvStableAt(o)` (false through `any`/cast). Otherwise stays Unknown.
4. **Classes table** (`buildClassesTable`): emits `Program.classes` with method
   names/fields interned to `Name` ids and method funcs resolved to FunctionIds.
5. **Name interning** (`internName`): member names → dense `Name` ids shared by the
   classes table and Method callees.

## Soundness fix found while wiring
Non-assignment expressions (`a + b`, unary, ternary) previously fell through
**without lowering their operands**, so a side-effecting call inside them (e.g.
`t + s.area()`) was dropped from the IR — unsound for escape analysis. Now binary/
unary/conditional expressions lower all sub-expressions for their effects.

## Verified end-to-end (real exporter output, not hand-built IR)
`classcall.ts`: `totalArea(shapes){ ... s.area() ... }` with `new Circle` only →
devirt yields **Direct(Circle.area)** (RTA collapses the polymorphic-looking call
because only Circle is instantiated). `classcall2.ts` adds `new Square` →
the same call becomes **Virtual{slot:0}**. The emitted `classes` table matches the
hierarchy (area→funcs, Circle.instantiated=true, all stable). Non-class programs
(closures.ts, sample.ts) export an empty classes table and still pass their e2e
(closures 27/27).

## Remaining
- get/set accessors and parameter-property fields into method lifting / layout.
- `super.m()` lowering to a Direct callee (devirt already supports super).
- codegen consuming `SiteDispatch` + classes to emit C structs/vtables.
