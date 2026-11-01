# Dictionary arrays

Session 363. Runtime (`runtime/ts_rt.c`, `runtime/ts_rt.h`).

## Why

`Object.defineProperty(arr, "1", { get() { ... } })` wrote the property map under the key "1", where no element read looks:
`arr[1]` kept the old element, `arr.length` did not move, silent. A read-only `length` and a non-writable element had no
representation. test262's `Object.defineProperty` and `Object.defineProperties` (1700 cases) and the ES5 families of
`Array.prototype` are built on these.

## The representation

An array has three element forms in `ts_array.sparse`: dense, sparse (a side table), and now dictionary
(`TS_ARRAY_DICT`). An element with an accessor or with an attribute of its own moves *every* element of its array to the
property map, under its index key, with its attributes; the array stays a `TS_KIND_ARRAY` cell, `len` stays the length. A
read-only length (`kind_spare & TS_ARRAY_LENGTH_READONLY`) forces the same form.

The form costs nothing to any other array, because of how the sparse form already works:

- `cap` is 0 and `data` is NULL, as for a sparse array, so every inline load and store (`ts_array_get_inline`,
  `ts_array_set_inline`, `ts_array_push_inline`, the emitted loops bounded by `cap`) leaves for the runtime.
- The side table stays allocated, empty: the collector's `a->sparse` paths need no case.
- `as_arr` answers NULL, so the runtime's array methods take the receiver as they take a Proxy (`TS_ARRAY_PROXY`, under
  `g_has_proxies`, which the first conversion sets): a dynamic call that reaches `ts_arrproto_*`, whose `ARR_THIS` reads
  the elements through `[[Get]]` and `arrproto_generic` takes the `arrlike_*` algorithms.
- `ts_array_get`, `ts_array_set`, `ts_array_has_index` and `ts_array_set_length` are the element interface of the rest of
  the runtime, and these four know the form. `ts_get`, delete, descriptors and enumeration go to the property map.

There is no way back to the dense form: an array that was given an accessor is rare enough, and a transition needs the
attributes checked.

## ArraySetLength

`array_define_length`: `value` is converted twice as the specification does (`ToUint32`, `ToNumber`), a mismatch is a
RangeError; `enumerable: true`, `configurable: true` and an accessor are refused; `writable: false` converts to the
dictionary form. A truncation goes from the top and stops at an element that cannot be deleted: the length stays above it
and the operation fails (`array_dict_truncate`). `arr.length = v` takes ToNumber (a string or an object converts) and throws
on a read-only length, a frozen array, and a sealed array's elements.

## Order of keys

`push_prop_names_part` is the one OrdinaryOwnPropertyKeys: the integer keys ascending by a sort, then the others in creation
order, with `length` between them for an array. Its selection sort was quadratic in integer keys.

## Gaps

- The methods over a dictionary array work on a snapshot of the elements (`arrproto_elements`): a getter runs once per element
  up front, and a callback that mutates the array does not see its changes. The specification's per-step `[[Get]]` is the
  generic library's (next slice).
- An element absent from a dense array does not consult `Array.prototype` (a hole reads undefined inline).
