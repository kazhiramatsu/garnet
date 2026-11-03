# Private names

Session 363. Exporter (`private_names.ts`, `exporter.ts`, `class_extract.ts`), runtime (`ts_rt.c`), emitter
(`emit_c.rs`).

## What was wrong

`#x` was a property whose key happened to start with a hash. Three consequences, all silent:

- `class A { #x = 1 } class B extends A { #x = 2 }`: one slot. `new B()` answered 2 from A's methods.
- `o.#x` on an object without it answered undefined; `o.#x = 1` created it; `#x in {}` was false only because
  nothing had stored it. V8 throws a TypeError for the first two.
- A string reached it: `o["#x"]`, `"#x" in o`, `hasOwnProperty("#x")`. A string field `"#a"` of a class was
  hidden from `Object.keys` as if it were private.

## The name

A private name belongs to the class body that declares it. The exporter's paths read a member's name as text
(about a hundred `.name.text` sites), so the identity is put in the text: right after parsing, before anything
binds, `uniquePrivateNames` gives each declaring class's names a spelling of their own, `#x` + `\x01` + a class
number, at the declaration and at every use, resolved lexically. Everything downstream (the layout, the method
tables, the field table) keeps working on text and now separates the two `#x`.

The host of every program parses through this pass (`privateNameHost`). `\x01` cannot be written in a private
identifier, so no program spells such a key; the runtime hides any key with the mark from reflection
(`field_name_is_internal`, `class_field_is_private`). `privateDisplayName` gives back `#x` for `fn.name`.

## The element

| name | where it lives | a read | a write |
|---|---|---|---|
| instance field | a struct slot of the declaring class | own slot | own slot |
| instance method | the class's prototype, the function known statically | the brand, then a direct call | TypeError |
| instance accessor | likewise | the brand, then a direct call | the brand, then a direct call; no setter: TypeError |
| static field, method, accessor | the class's static container | own property | own property; a method: TypeError |

The **brand** of a class with instance private methods or accessors is one more hidden field (`#brand\x01n`),
set first thing in `emitFieldInitializers`: a method has no slot whose presence could answer `#m in o`.

`private.check:<key>` (`ts_private_check`) is own-only: the chain has no part in it and a Proxy is not asked
(`Object.create(new A()).#x` and `new Proxy(new A(), {}).#x` throw). A check is skipped when the receiver is
proven (`privateReceiverProven`): a receiver typed as the class or a subclass, trusted as every typed access is,
or `this` in a program with no foreign receivers at all (`closedReceivers`); a typed program without them pays
nothing, its reads and writes are the struct's.

Any other check of an instance element is `private.check:<key>:<class>`, tested in line (`private_check_expr`): the
receiver is an object and its class index is in the declaring class's interval. That is the runtime's own answer: on a sized
instance `ts_has_own` asks whether the class's layout has the slot (`class_field_lookup`), and every class of the interval has it.
Everything else takes the call, a relinked instance among them (out of the interval, its fields are its own). The call
on every `this.#x` of a program with foreign receivers cost hono 14% of its instructions and PatternRouter 23% of its time, a
name lookup per read (Session 363). The test reads `cls` from whatever the check is given, so it rests on every cell with the
object selector answering that word: a BigInt had to stop keeping a limb there (`types/bigint_cell_words`,
`classes/private_check_receivers`).

The load and the store after the check are the ordinary `LoadField` and `StoreField`, not a runtime call of their
own: every field analysis (the store-proven integer slots, the frozen tests) keeps seeing every store.

## Gaps

In `tests/conformance/KNOWN_GAPS.md`:

- **One name per declaration, not per evaluation.** A class in a function evaluated twice shares its names:
  an instance of one evaluation passes the other's check (V8 throws).
- **An element read before its initializer ran** answers undefined (V8: a TypeError). The slot exists from the
  allocation.
- **`super()` returning another object**: the fields go on the instance garnet allocated, not on that object
  (as with public fields). A second initialization of a name on one object is not detected.
- **A frozen object's private field** cannot be written (V8 can: a private element is not a property).
