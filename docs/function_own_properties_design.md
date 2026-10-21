# A function's own properties

## Problem

A function value keeps three of its own properties outside its property
map: `length` and `name` are derived from the boxed metadata (`arity`,
`name` of `ts_func`), and `prototype` lives in `prototype_prop` (created on
first observation). Only the paths that take the function itself as the
receiver knew them, and not consistently:

- through a prototype chain (`Object.create(fn).name`, `.prototype`, `in`,
  `Reflect.get/has`) the function link was looked up in its property map
  only: undefined, false;
- `fn.name = x` and `fn.length = x` were silently ignored (strict code must
  throw: both are read-only), and an inherited one was shadowed by a new own
  property of the receiver instead of throwing; so was a class's
  `prototype` (non-writable);
- `delete fn.x` was a no-op for every key of every function (user
  properties, class statics, `name`, `length`) and returned true even for
  the non-configurable `prototype`;
- `Object.defineProperty(fn, "name", ...)` stored an entry that reads never
  saw (the metadata won).

## Model

`name` and `length` are virtual own data properties — the metadata's
value, writable false, enumerable false, configurable true (false once the
function is sealed or frozen) — unless superseded:

- an own entry by that key exists: in the function's property map, or for a
  class value in its static container (the class setup defines `name` and
  `length` there for classes with statics), and that entry is the
  property;
- or it was deleted, or replaced by a definition: `ts_func` records that
  with one bit per key (`name_gone`, `length_gone`, bit-fields sharing the
  byte of `proto_lazy`, so the cell layout is unchanged).

`prototype` keeps its slot: writable for functions, not for classes, never
configurable. Every operation on a function — as the receiver or as a link
of another object's chain — applies the same rule:

- **get**: the prototype slot, then (a class) its static container, then
  the virtual property, then the property map, then the chain;
- **has / own**: true for the prototype slot and a virtual property;
- **set**: a virtual property or a class's prototype is read-only: strict
  TypeError, as the receiver and as an inherited link (an inherited
  writable `prototype` of a plain function lets the receiver create its
  own);
- **delete**: the prototype slot is non-configurable (false; strict
  TypeError); a virtual property sets its bit; a class value deletes from
  its static container, a plain function from its property map; sealed and
  frozen functions refuse;
- **defineProperty** of `name` or `length` while virtual first turns the
  virtual property into a real entry with its current attributes and sets
  the bit, then applies the descriptor as for any existing property;
- **descriptors and key lists** report the virtual properties in V8's
  order (`length`, `name`, `prototype`, then the map).

The absent-property caches never record a chain through a function link,
and the inline caches do not serve function receivers, so no cached
decision can bypass the rule.

## Verification

Fixture `functions/function_own_properties`: reads, `in`, `Reflect` and
writes through chains of plain functions, arrows, classes with and without
statics and derived classes; writes to `name`, `length` and `prototype` as
the receiver; deletions of user properties, statics, `name`, `length` and
`prototype`; definitions of `name` and `length`; descriptors and key lists
after each; sealed and frozen functions. Runtime only: conformance, unit,
GC stress, selfconf; the compiler A/B for the extra branch in the chain
walk.

## Implementation

`fn_virtual` (`ts_rt.c`) decides whether `name` or `length` is virtual for
a function; `fn_link_get` and `fn_link_has` answer a function link of a
chain walk (`lookup_prop_chain`, `lookup_prop_chain_until`, `ts_has_prop`)
and the inherited loop of `ts_set_named_prop` throws for its read-only
properties; `fn_delete` serves `ts_delete_prop` and `ts_delete_prop_strict`
(the object deletion became `props_delete_own`, shared with a function's
map and a static container); `fn_realize_virtual` runs before
`define_own_property`, `ts_define_data` and `ts_define_accessor_attr`
apply to a function. `Object.keys` and the other own-enumerable walks now
list a plain function's own map (they returned nothing). The chain walk
pays one compare of the link's kind.

Remaining, not changed: a class value's chain is its static containers,
so `Object.create(K).call` does not reach `Function.prototype`; a class
value's own map (properties defined on it with `Object.defineProperty`)
is missing from `Object.getOwnPropertyNames`.
