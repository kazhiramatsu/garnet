# Standard library method coverage

tsaot implements stdlib methods via a generic `CallBuiltin` IR instruction: the
exporter classifies the receiver's type (string / array) through the checker and
emits `CallBuiltin{builtin:"array.map", recv, args}`; emit_c maps the builtin name
to a `ts_*` runtime helper. Callback-based methods (map/filter/forEach/reduce)
pass a first-class `ts_func` and invoke it via `ts_call`.

SAFETY: a method called on a *known* builtin string/array type that is NOT in the
implemented set is rejected loudly at export time (TSAOT_ALLOW_UNSUPPORTED to
override), never silently miscompiled. Methods on user classes are unaffected
(they take the normal devirt/dynamic dispatch path).

## Implemented (verified vs V8, ASan-clean)
String: toUpperCase, toLowerCase, toLocaleUpperCase, toLocaleLowerCase, slice,
        substring, substr, indexOf, lastIndexOf, includes, charAt, charCodeAt,
        codePointAt, concat, repeat, trim, split, startsWith, endsWith,
        padStart, padEnd, trimStart, trimEnd, trimLeft, trimRight, at,
        isWellFormed, toWellFormed, normalize, replace, replaceAll
Array:  map, filter, forEach, reduce, indexOf, includes, slice, concat, join,
        push, pop, find, findIndex, some, every, lastIndexOf, at, reverse,
        shift, unshift, fill, sort (default + comparator; stable insertion sort),
        splice, flat, flatMap, findLast, findLastIndex, entries, keys, values,
        reduceRight, copyWithin, toString, toSorted, toReversed, with, toSpliced.
        Static Array.isArray, Array.of, Array.from.
Map:    set, get, has, delete, clear, size, keys, values, entries, forEach
        (any key type via SameValueZero; insertion order preserved; GC-traced;
        open-addressing hash index with cached per-entry hashes)
Set:    add, has, delete, clear, size, keys, values, entries, forEach
        (SameValueZero dedup)
WeakMap:set, get, has, delete (object/function/non-registered-Symbol keys;
        ephemeron GC semantics; Symbol.for keys rejected)
WeakSet:add, has, delete (object/function/non-registered-Symbol keys;
        weak GC semantics; Symbol.for keys rejected)
Math:   sqrt abs floor ceil round trunc sign sin cos tan asin acos atan sinh
        cosh tanh exp log log2 log10 cbrt pow atan2 hypot max(2) min(2) random
        asinh acosh atanh expm1 log1p fround f16round clz32 imul
        + constants PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2.  The transcendental
        functions are V8's implementations (runtime/ts_ieee754.c, a C translation of
        V8's fdlibm port; pow is V8's wrapper over the platform pow), so results agree
        with Node to the last bit; sqrt/abs/floor/ceil/fround are the exact libm/C ops.
Number: isInteger isFinite isNaN isSafeInteger parseFloat parseInt, Number(x)
        coercion, constants MAX_SAFE_INTEGER MIN_SAFE_INTEGER MAX_VALUE MIN_VALUE
        EPSILON.  Global parseInt / parseFloat / isNaN / isFinite.
        Global encodeURIComponent / decodeURIComponent / encodeURI / decodeURI (URIError on malformed input).
        The four also as values (`["a b"].map(encodeURIComponent)`, `typeof encodeURIComponent`): the global
        object's functions, set up for a program that names one as a value (Session 353).
        String.prototype[Symbol.iterator] as a method (`"ab"[Symbol.iterator]()`, the code points), and a
        symbol-keyed read on a string or number primitive through its prototype (Session 353).
        Number.prototype toString, toFixed, toPrecision, valueOf.
String static: fromCharCode, fromCodePoint.
Date:   new Date(), new Date(epochMs), component constructor, Date.now(),
        getTime, valueOf, getFullYear/getMonth/getDate/getDay/getHours/
        getMinutes/getSeconds/getMilliseconds/getTimezoneOffset, UTC variants,
        toISOString.
Object: keys, values, entries, assign, fromEntries, freeze, isFrozen, seal,
        preventExtensions, isSealed, isExtensible, create(proto), hasOwn,
        getOwnPropertyNames, getOwnPropertySymbols, getOwnPropertyDescriptor(s),
        defineProperty, defineProperties, getPrototypeOf, setPrototypeOf, is.
        Object.prototype toString, toLocaleString, valueOf, hasOwnProperty,
        isPrototypeOf, propertyIsEnumerable.
JSON:   stringify (primitives/arrays/objects/Map; functions+undefined omitted;
        NaN/Infinity -> null; depth-capped; null/undefined replacer and `space`
        supported), parse with optional reviver (objects/arrays/strings/numbers/
        true/false/null; objects use compile-consistent field ids so dot access
        works on parsed results); typed parse through `garnet:json`
        (`JSON.parse<T>(text)` validated against T, objects in T's layout,
        a TypeError naming the path; docs/typed_json_design.md)
garnet:ndarray: NDArray over typed storage (float64 fast path; float32, int8..uint32,
        float16, bfloat16 through the dtype), creation (zeros ones full generate
        fromFunction from tensor arange linspace eye), row views, reshape, astype,
        add sub mul div map exp log sqrt tanh sigmoid clip maximum minimum, sum mean
        max min argmax argmin, dot outer transpose, slice concat flatten, equals
        allclose, rows/entries/values generators, Random (uniform normal integers
        shuffle stream); docs/ndarray_design.md
Promise: constructor executor, resolve/reject/all/race/allSettled/any,
        then/catch/finally.
RegExp: literal and constructor objects (a constant or a dynamic pattern and
        flags) with optional QuickJS fallback; test/exec/search/match/matchAll/
        replace/global replaceAll/split, captures, named groups, basic `d`
        indices, `u`/`v` Unicode mode, extracted test/exec method values.
Typed arrays (docs/typed_arrays_design.md): ArrayBuffer (byteLength, slice)
        and SharedArrayBuffer; Int8/Uint8/Uint8Clamped/Int16/Uint16/Int32/
        Uint32/Float32/Float64Array from a length, an array-like or iterable,
        or a buffer with offset and length; `T.from`, `T.of`; element
        conversion on store; length, byteLength, byteOffset, buffer,
        BYTES_PER_ELEMENT; subarray, slice, set, fill, copyWithin, indexOf,
        lastIndexOf, includes, join, toString, reverse, sort, forEach, map,
        filter, reduce, every, some, find, findIndex, keys, values, entries,
        iteration, JSON output; Atomics on integer views.
Fetch/Web subset: optional libcurl-backed fetch, Response.text/json/status/ok/
        headers, simplified Headers, AbortController/AbortSignal.timeout.
(plus .length for string/array, .size for Map/Set.)

Math single-arg functions are emitted inline as double calls: sqrt/fabs/floor/ceil
are libm, the transcendental ones are the runtime's V8 port (ts_m_sin(x)...,
TSAOT_IEEE754_MATH=0 emits the libm names); two-arg/JS-specific ones (round
half-up, sign, trunc, max/min/hypot) use runtime helpers. Link with -lm. JS `/` is always float division and `%` is fmod, EXCEPT
`intLocal % nonzeroIntConstant` which stays integer-fast (no FPE; hot `% C` loops
keep native speed).

Map/Set are runtime containers (TS_KIND_MAP/SET) with insertion-order dense
arrays and an adaptive open-addressing side index. SameValueZero hashes are
cached beside the dense entries, avoiding repeated string/content hashing and
most equality checks on collision chains. Collections below eight live entries
retain the cache-friendly linear fast path; larger collections have expected
O(1) lookup. WeakMap/WeakSet reuse that index but are non-iterable. Their GC
handling is described in [weak_collections.md](weak_collections.md).

Iterable constructor seeding is supported for the common array/iterator paths.
Callbacks for map/filter/forEach/reduce and Map/Set.forEach are first-class
closures invoked via ts_call, which prepends the closure's captured environment.

## NOT yet implemented (rejected loudly)
- String: localeCompare, toLocaleString, full Intl locale casing beyond
  the currently guarded default + Turkish/Azeri `toLocaleUpperCase` /
  `toLocaleLowerCase`, and remaining string-pattern RegExp consumers outside the
  const-pattern paths.
- Array: toLocaleString and locale-aware element formatting.
- Map/Set: ES2023 Set algebra methods such as union, intersection, difference,
  symmetricDifference, isSubsetOf/isSupersetOf/isDisjointFrom.
- Object/Symbol reflection: remaining symbol-keyed reflection beyond own-key
  discovery and descriptors.
- Math: newer proposal methods if targeted.
- Number: toLocaleString.
- Date: string/Date argument parsing, setters, toString/toUTCString/toLocale*
  formatting, and other formatting helpers.
- JSON.stringify replacer function/array semantics.
- RegExp: the constructor as a first-class value (`const R = RegExp`,
  `globalThis.RegExp`) remains rejected; non-global `matchAll`/`replaceAll` are
  rejected at export time instead of becoming a runtime TypeError.
- Web/fetch: streaming request/response bodies, abort events, real DOMException
  objects, and full Web-compatible Headers/Request/Response semantics.
- Typed arrays: at, findLast, findLastIndex, toSorted, toReversed, with
  (export-time rejects), reduceRight (a TypeError at run time), DataView.
- WeakRef / FinalizationRegistry and Intl (a runtime ReferenceError) are
  outside the current implemented surface.
- BigInt: DEFERRED. Arbitrary-precision integers do not fit the NaN-boxed double
  and need a separate heap bignum representation plus all arithmetic/bitwise/
  comparison/toString ops — a standalone project. Until then BigInt literals
  (123n) and BigInt(x) are rejected loudly (never silently miscompiled).

## Design notes
- Receiver classification uses checker TypeFlags (String/StringLiteral) and symbol
  name "Array" / `T[]` / `Array<T>` type-string shapes. `any`-typed receivers are
  NOT treated as builtins (fall through to dynamic dispatch).
- slice/substring take (start, end?, has_end) so optional end is handled.
- indexOf/charCodeAt/array.push return numbers (set_num); others return tsv.
- Current next-priority candidates are tracked in docs/TODO.md; this document is
  only the stdlib surface snapshot.


## Field-name table & enumeration (Approach B)
JSON.stringify / Object.keys|values|entries need to recover string property names
from the interned field-id keys. The compiler emits a static FIELD_NAMES[] table
(id -> name) into the C output; ts_init_fields seeds a runtime table at startup.
JSON.parse interns names back to the SAME ids (ts_intern_field), so dot access on
parsed objects works for names the program already uses; novel keys get fresh ids.

Tradeoff: an object whose class is ever passed to one of these enumerating
builtins must keep its fields in the prop map (not unboxed struct fields), or the
runtime could not walk them. compute_enumerated_classes finds such classes and
excludes them from the typed-struct-field layout / struct field access (they use
ts_set/ts_get). This costs some speed for those specific classes but is required
for correct enumeration; classes never enumerated keep the fast struct layout.
