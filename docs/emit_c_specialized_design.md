# emit_c: specialized class path

The C emitter now has two paths and chooses per-value using the analysis:

## Specialized (fast) path — typed class instances
Triggered when a local is a known class instance: either a class-tagged
`AllocObject{classId}` (from `new C()`), a `Copy` of one, or param 0 of a
method/constructor (the owning class's `this`, via a func->class map).

- **Prefix-layout structs**: `struct ClassN { ts_object header; tsv f..; }` with
  inherited fields inlined parents-first as a fixed prefix, so every field is a
  constant-offset C member. The `ts_object header` keeps the layout
  pointer-compatible with the runtime object model (so `ts_obj`/`ts_ptr` and the
  GC still work on a typed instance).
- **Stack allocation**: a `new C()` at a NoEscape + determinable + once site is a
  C local `ClassN sobjN;` — no heap allocation at all. Escaping/loopy sites fall
  back to a heap object of the same layout.
- **Typed field access**: `LoadField`/`StoreField` on a typed local become
  `((ClassN*)ts_ptr(v))->fK` — a direct struct member load/store, NOT a hashmap
  `ts_get`/`ts_set`. This is the V8-beating move: no hidden-class guard, no IC.
- **Calls**: `Direct` (devirt mono / super / ctor) -> direct `FN_TABLE[id]` call;
  `Set` -> first candidate (vtable slot wiring is the next step); the constructor
  is reached as a `Direct` call with the new object as `recv`.

## Dynamic (fallback) path — everything else
`any` / unstable / unknown-shape values stay NaN-boxed `tsv` and use
`ts_new_object` + `ts_get`/`ts_set` + dynamic dispatch. Always correct, always
available; the specialized path is a sound overlay, never a replacement.

## Soundness: unified field identity
The critical bug fixed here: class field ids in the `classes` table and the field
ids in `LoadField`/`StoreField` must be the SAME intern space, or a typed store
in the constructor and a typed read in a method would disagree on the offset.
The exporter now interns class `ownFields` through `internField` (the same table
Load/StoreField use). `new C()` lowering emits `AllocObject{classId}` + a `Direct`
constructor call (recv = new object); the ctor is added to the class's
`ownMethods` (sentinel `__ctor__`) so codegen types its `this`.

## Verified end-to-end (real exporter output)
`spec.ts`: `class Point{x;y;constructor(x,y){this.x=x;this.y=y} sumXY(){return this.x}}`,
`make(){ const p=new Point(3,4); return p.sumXY(); }`.
Emitted C: `struct Class0{ts_object header; tsv f1,f2;}`, `make` stack-allocates
`Class0 sobj1`, ctor stores `((Class0*)ts_ptr(v0))->f1=...`, method reads it.
Compiled+run via a harness passing (3,4): prints 3, 4, 3 — typed fields written
and read through direct struct access, instance on the stack, no hashmap ops.
Dynamic-path program (42/hello) and 24 runtime tests still pass; spec.c compiles
standalone.

## Remaining
- vtable instances + `Virtual` dispatch emission (Set -> `obj->vt->slot(obj,..)`).
- literal lowering (numbers/strings) so whole programs run without a harness.
- unboxed numeric path (keep double/int out of `tsv` through arithmetic).
- arena allocation for NoEscape-many / ArgEscape.
