# Array element keys that are not indices

Found while writing the payload-heap fixtures (GC v2, slice G2b): element
access on an array silently read and wrote the wrong element whenever its key
was not an array index.

## 1. String keys (exporter)

`indexAccessKind` sent every element access on an array or string receiver
down the index path (`LoadIndex` / `StoreIndex`), whatever the key's type. The
index path reads its key as a raw number — the emitted access is
`ts_array_get_inline(a, (uint32_t)ts_to_num(k))`, and `ts_to_num` reinterprets
the bits — so a string key became NaN, then 0: `for (const k in arr) arr[k]`
read element 0 for every k, `arr["2"]` through a variable read element 0, and
`arr[k] = v` overwrote element 0.

Rule: on an array or string receiver only a number-typed key (number, a
number literal, a numeric enum, a union of those) takes the index path. Any
other key — a string, `any`, a non-numeric union, a type parameter — takes the
dynamic path (`LoadFieldDynamic` / `StoreFieldDynamic`), whose ToPropertyKey
maps a canonical index string to the element and anything else to a named
property. In the compiler, the index path keeps every site with a number
key. Fixture `arrays/string_index_keys`.

## 2. Number keys that are not indices (runtime and emitter)

An array index is an integer in [0, 2^32 - 1). Any other number is a property
key under ToString: `a[-1]` is `a["-1"]`, `a[1.5]` is `a["1.5"]`,
`a[4294967295]` is a named property, `a[NaN]` is `a["NaN"]`; `a[-0]` is
element 0. Today three paths truncate instead:

- the emitted index path casts the key to `uint32_t` (`a[1.5]` reads `a[1]`;
  an int64 key 2^32 + 1 reads `a[1]`; a double out of range is undefined
  behavior in C);
- `ts_get_dyn` / `ts_set_dyn` on an array with a number key cast the same way,
  so `any` receivers share the bug; a store of a non-index key throws
  RangeError ("Invalid array index") instead of creating the property;
- `ts_has_prop_dyn` (`k in arr`) answers false for a non-index number without
  looking at the named properties.

Design:

- `ts_num_array_index(double d, uint32_t* i)`: d is an index when
  0 <= d < 2^32 - 1 and `(double)(uint32_t)d == d` (the range test comes
  first, so the conversion is defined).
- Dynamic paths: an index goes to the element path as before; any other
  number falls through to the ToPropertyKey path (`ts_key_from_value`, then
  `ts_get` / `ts_set` / `ts_has_prop`). Fixed-kind arrays (`Uint16Array`) keep
  the integer-indexed exotic rule: a non-index numeric key reads undefined
  and its store is ignored.
- Emitted element access, by the C type of the index operand:
  - an int64 local (the integer-specialized locals, 95% of the compiler's
    index operands): the in-line helpers take `int64_t`; the in-capacity test
    `(uint64_t)i < a->cap` also rejects negative values and values past
    2^32 - 2, so the hot path costs what it costs today; past the capacity a
    dense array answers undefined only for an index (`(uint64_t)i < 2^32 - 1`)
    and otherwise leaves for the out-of-line key path;
  - a double operand (5%): `ts_num_array_index` first, the key path for a
    non-index;
  - the out-of-line key paths (`ts_array_get_key_*` / `ts_array_set_key_*`)
    use the element path for an index and the dynamic property path
    (`ts_get_dyn` / `ts_set_dyn` with the number) otherwise.
- `TSAOT_INDEX_KEYS=0` keeps the previous emission for the parity oracle.

`ts_has_prop_dyn` likewise: an index tests the element, any other number
the named properties. `delete` already converted its key with
ToPropertyKey.

Fixture `arrays/numeric_index_keys`: reads and writes at -1, 1.5, NaN,
Infinity, 2^32 - 1, 2^32 + 1 and -0 through int, double and boxed keys, on
dense and sparse arrays, `in`, `delete`, `Object.keys`, and an `any` receiver.
