# Dynamic classes

Session 363. Exporter (`class_extract.ts`, `exporter.ts`), runtime (`ts_rt.c`), emitter (`emit_c.rs`).

## Why

A class in garnet is one thing for the whole program: one layout, one vtable, one prototype template. That is what
makes typed classes fast, and it does not fit four kinds of class, each of which was a compile-time reject:

- `class X extends <expression>`: a mixin, a conditional, a binding that holds a constructor, `extends null`;
- `class X extends Map` (Array, Set, Promise, Date, ...): the instance has to be the built-in's kind;
- a method, an accessor or a static initializer that captures a local of the function around the class: the
  function is one, the evaluations are many;
- `class Y extends X` for any `X` of the above.

Real programs write all of these (mixins, `extends Map`, a class declared in a factory; effect's `Schema` is built
from them). test262 has hundreds.

## The idea

Such a class is what the specification says a class is: a value made at run time. It is not registered with the
class extractor, so nothing in the exporter types it: `classOfExpr` does not know it, its instances are read and
written by key, its methods are found on the chain, `new` goes through `ts_construct`. There is no layout to
disagree with and every evaluation is its own class. Only such classes pay; a typed class is untouched.

`isDynamicClass` decides, from the declaration alone, before anything is laid out.

## Evaluation

`lowerDynamicClass` lowers ClassDefinitionEvaluation in the enclosing function:

1. the heritage expression;
2. the constructor closure `F`, and `dynclass.define` (`ts_dyn_class`): the checks on the base, the prototype
   object, `F.prototype`, `prototype.constructor`, `F`'s own prototype;
3. the members in source order: computed keys are evaluated here, methods and accessors become closures defined on
   the prototype or on `F`, not enumerable; a computed key of a field waits on the prototype under a hidden key
   (per evaluation, unlike the static classes' global);
4. the class's name is bound;
5. static fields and blocks in order, with `this` being `F`.

Methods reach `super` through a home cell, as an object literal's do: one for the prototype, one for `F`.

## The constructor

`F` is the closure of the constructor declaration, or of a synthetic one when the class has none. `new` reaches it
through `ts_construct`, which leaves the `new.target` and the active function for its entry (`dynclass.enter`); a
plain call finds nothing there and throws.

- A base class makes `this` from `new.target.prototype`, then runs the field initializers.
- A derived class has no `this` until `super(...)`: `ts_dyn_super` constructs `F`'s prototype with the same
  `new.target`, and a parent that is no dynamic class gets its instance relinked to `new.target.prototype`
  afterwards. The field initializers run when `super` returns. A read of `this` before that is a ReferenceError, a
  second `super()` too (after the construction, as the specification orders it).
- A `return` follows the constructor rules (`dynclass.result`).

Field initializers are lowered in the constructor, whose free variables include theirs.

## Built-in bases

`super(...)` over a built-in needs the built-in as a constructor value: the function values of `Map`, `Set`,
`WeakMap`, `WeakSet`, `Date`, `Array`, `Promise` and the rest construct when `ts_construct` calls them, and throw
when called plainly where the specification says so.

## Private names

They work as in `docs/private_names_design.md`, without the typed shortcuts: a member's check is always made, a
method or an accessor lives on the prototype under its hidden key, and the brand is an own hidden property.

## Gaps

- `super()` inside an arrow function is a compile-time reject in such a class.
- Parameter defaults run before the field initializers of a base class (the specification has them after).
