# Typed arrays

## Why

tsc-ts (`docs/tsc_ts_native_design.md`) builds its scanner tables, relation
caches, hashing and diagnostics on typed arrays (`new Int32Array` 38 sites,
`Uint8Array` 29, `Uint32Array` 7, `Uint16Array` 6, `Float64Array` 6), with
views over another array's buffer (`new Uint8Array(words.buffer, ...)`),
`SharedArrayBuffer` counters, `subarray`, `fill`, `copyWithin`, `T.from`
and `Atomics`. Any TypeScript program that does binary or numeric work does
the same. garnet has only `Uint16Array`, as a special case of the ordinary
array (8-byte tsv elements with a write coercion, no buffer, no views).

## Representation

Two new cell kinds, so that no existing array fast path can take a view for
an array (they all test `TS_KIND_ARRAY`):

```c
typedef struct ts_arraybuffer {   /* TS_KIND_ARRAYBUFFER */
  ts_obj_common o;                 /* ArrayBuffer.prototype / SharedArrayBuffer.prototype */
  uint8_t* bytes;                  /* zeroed, outside the heap; freed with the cell */
  uint32_t byte_length;
  uint8_t shared;
} ts_arraybuffer;
typedef struct ts_typedarray {    /* TS_KIND_TYPEDARRAY */
  ts_obj_common o;                 /* the element type's prototype */
  uint8_t* data;                   /* bytes + byte_offset of the buffer */
  uint32_t length, byte_offset;
  uint8_t elem;                    /* TS_TA_INT8 .. TS_TA_FLOAT64 */
  tsv buffer;                      /* keeps the buffer, hence data, alive */
} ts_typedarray;
```

The bytes never move (they are not a payload of a moving space), so a
view's raw `data` stays valid while its buffer lives, and the view holds the
buffer. They pace the collections like cell bodies (the young collection's
payload budget and the heap bytes of the full collection's threshold): a
loop of short-lived 1 MB buffers otherwise grew to 1.5 GB before its first
collection. Both kinds carry the common header (named properties, prototype).
A SharedArrayBuffer is an ArrayBuffer whose `shared` bit selects its
prototype: garnet runs one thread, so nothing else can observe it.

## Semantics (ECMAScript, the subset tsc-ts and ordinary programs use)

- `new T()`, `new T(length)` (RangeError beyond 2^32 - 1 or negative),
  `new T(arrayLike or typed array)` (copy, element conversion),
  `new T(buffer, byteOffset?, length?)` (a view; RangeError when the
  offset is not a multiple of the element size or the view leaves the
  buffer); `new ArrayBuffer(n)`, `new SharedArrayBuffer(n)`; `T.from`,
  `T.of`.
- An integer index in range reads the element (a number) and writes
  ToNumber then the element conversion (ToInt8, ToUint8, ToInt16,
  ToUint16, ToInt32, ToUint32, Float32 rounding); out of range reads
  undefined and writes are ignored; other keys are ordinary properties.
- `length`, `byteLength`, `byteOffset`, `buffer`, `BYTES_PER_ELEMENT`;
  ArrayBuffer `byteLength` and `slice`.
- Methods: `subarray`, `slice`, `set`, `fill`, `copyWithin`, `indexOf`,
  `lastIndexOf`, `includes`, `join`, `toString`, `at`, `reverse`, `sort`
  (numeric), `forEach`, `map`, `filter`, `reduce`, `every`, `some`, `find`,
  `findIndex`, `keys`, `values`, `entries`, iteration.
- `typeof` object, `Object.prototype.toString` `[object Int32Array]`,
  `Array.isArray` false, `JSON.stringify` as an object with index keys,
  `Array.from` and spread through iteration.
- `Atomics.load/store/add/sub/and/or/xor/exchange/compareExchange` on
  integer views: the plain read-modify-write, returning the old value.

## TA1 as built

- **Lowering.** `new T(...)` lowers to `typedarray.new:<elem>` (variadic, the
  runtime sorts out a length, an array-like or iterable, or a buffer with
  offset and length), `new ArrayBuffer(n)` / `new SharedArrayBuffer(n)` to
  `arraybuffer.new:<shared>` (an options argument, a resizable buffer, is
  rejected), `T.from` / `T.of` to `typedarray.from:<elem>` /
  `typedarray.of:<elem>`, `ArrayBuffer.isView` to `arraybuffer.isView`,
  `T.BYTES_PER_ELEMENT` to a constant and `x instanceof T` to a prototype
  chain test against `protoobj.typedarray:<elem>` (or the buffer prototypes).
  A view's element access with a number-typed key takes LoadIndex/StoreIndex,
  whose array entries hand any other receiver to `ts_array_get/set`, which
  read and write the element; any other key is a property key
  (`ta_get_key` / `ta_set_key`: canonical numeric strings name an element or
  nothing, the accessors `length`, `byteLength`, `byteOffset` and `buffer`
  are virtual and setting one throws, other keys are ordinary properties).
- **Methods** are prototype methods for every receiver (the dynamic method
  call reads the field, then calls it); TA2 can dispatch them statically.
  `%TypedArray%.prototype` holds the shared methods and `Symbol.iterator`;
  each element type's prototype holds `BYTES_PER_ELEMENT` and `constructor`.
- **Constructor values.** The prototypes come with constructor function
  values (`prototype`, `BYTES_PER_ELEMENT`, `from`, `of`, `isView`); a program
  that names one as a value gets them on its global object. Calling one throws
  "Constructor T requires 'new'"; constructing through a value throws, as for
  the other builtin constructors held as values.
- **Reflection.** Elements are own enumerable, writable, configurable data
  properties that cannot be deleted; `defineProperty` on an element stores a
  value and refuses an accessor or an explicitly false attribute; a view with
  elements cannot be frozen (the attempt leaves it non-extensible, as in V8)
  nor sealed while extensible.
- **Array.prototype on other receivers.** `Array.prototype.map.call(view, f)`
  and the other reading methods run on an array of the receiver's elements
  (a view, a string or an array-like object); `reverse`, `fill` and
  `copyWithin` on a view use the view's own; the other mutating methods throw
  for a receiver that is not an array instead of changing a copy. The rest of
  `const [x, ...r] = view` is an array of the remaining elements.
- **Default-library globals.** An identifier that names a value of the
  default library and has no lowering of its own (`Intl`, `WeakRef`, ...) is
  read from the global object (undefined when the runtime does not model it)
  instead of from a local nothing assigns.
- **Messages** follow V8 (the RangeErrors name the offending number, a bad
  callback is described as V8 does).

## TA2 as built

Measured after TA1 (kernels in the session scratchpad; node takes about
160 ms on each): a byte sieve 3.2x slower than node, an Int32 histogram
5.7x, Float64 loops 5.9x, subarray/set/byte loops 8.9x. Each element access
of a view took the generic element entry (the array test fails, the lazy
frame is linked, `ts_array_get_key_i64`, `ts_array_get`, `ts_ta_get`
switching on the element type and boxing), and `view.length` was a
property read missing the inline cache.

- **IR hints.** LoadIndex, StoreIndex and LoadField carry `elem` (0 none,
  else the element type + 1) when the exporter sees a receiver whose static
  type is a view of one element type (`viewElemOf`; a union of views of one
  element type too). The hint never decides correctness: the emitted code
  tests the receiver.
- **Element reads.** `ts_ta_try_load_i/f`: kind and element-type test,
  bounds, the typed load (memcpy; the element type is a constant, so the
  switch folds), in line; any other receiver, element type or index takes
  the generic entry as the access point's slow path (linked like the array
  read's). An unboxed destination takes the double; a boxed one keeps
  undefined for an index out of range.
- **Element stores** of an unboxed numeric value: `ts_ta_try_store_i/f`
  with the conversion in line, the generic entry otherwise. Such a store is
  an access point (`is_view_store_point`: the in-line store cannot
  collect), so loops over views keep their lazy frames. A boxed value keeps
  the generic store (its ToNumber may run user code).
- **`length`** of a receiver typed as a view: in line when the view has no
  own properties (an own `length` shadows the accessor), the property read
  otherwise.
- **The generic element entries** (`ts_array_get_key_*`,
  `ts_array_set_key_*`) answered undefined for, and dropped writes to, any
  receiver without elements of its own: a value its static type does not
  describe (an object cast to an array or a view) is now read and written
  by the index as a property, null and undefined throw, and a write to
  another primitive throws as strict code does.

After TA2: sieve 1.1x node, Float64 loops 1.8x, subarray/set/byte loops
3.75x; the histogram is held back by `Math.imul`, an out-of-line call (the
typed array half of it is 2x node). Next: the loop-invariant receiver's
data and length hoisted out of loops (the bytes do not move, a view's
length is fixed), static dispatch of the methods, `for...of` over views as
an index loop, allocation of small buffers.

## TA3 as built

`Atomics.load`, `store`, `add`, `sub`, `and`, `or`, `xor`, `exchange`,
`compareExchange`, `isLockFree`, `wait` and `notify` lower to runtime calls
(`atomics.<name>`; a missing operand reads undefined). garnet runs one
thread, so each is the plain read-modify-write of the element. The checks
and conversions follow the spec and V8's messages: an integer element type
(Uint8Clamped and the float views are refused; `wait` and `notify` take an
Int32Array, `wait` only over a SharedArrayBuffer), ToIndex with a
RangeError past the end, ToIntegerOrInfinity of the operand (`store`
returns it), the bitwise operations on the element's bits, the old value
returned, `compareExchange` comparing the element's bytes with the expected
value converted to the element type. Nothing can notify the one thread:
`wait` answers "not-equal" for a different value, sleeps a finite timeout
and answers "timed-out", and throws for an unbounded wait instead of
hanging; `notify` wakes nobody (0). The namespace exists as a value too
(`typeof Atomics`, `[object Atomics]`, its functions callable dynamically)
in a program that names it. Fixture `stdlib/atomics`.

## Slices

1. **TA1, correctness**: the kinds, GC (scan the buffer slot and the
   common header, free the bytes), construction, element access through the
   generic paths (`ts_get_dyn`, `ts_set_dyn`, the array element entries for
   non-array receivers), the properties, the methods as exporter builtins
   for receivers typed as views and as prototype methods for dynamic
   receivers, iteration, the observable tags. `Uint16Array` moves to the
   new representation. Fixtures: construction and conversion, views and
   aliasing, every method, dynamic receivers, GC stress (views keep
   buffers alive across moving collections): `stdlib/typed_arrays`,
   `stdlib/typed_array_methods`, `stdlib/typed_array_reflection`,
   `gc/typed_array_buffers`.
2. **TA2, speed**: for receivers whose static type is a view, element loads
   and stores and `length` in line (kind test, bounds, typed load/store,
   the generic path otherwise); the analyzer may keep integer elements
   unboxed.
3. **TA3**: `Atomics`.
