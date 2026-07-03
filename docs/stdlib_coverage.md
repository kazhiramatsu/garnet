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
        substring, indexOf, lastIndexOf, includes, charAt, charCodeAt,
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
        (any key type via SameValueZero; insertion order preserved; GC-traced)
Set:    add, has, delete, clear, size, keys, values, entries, forEach
        (SameValueZero dedup)
Math:   sqrt abs floor ceil round trunc sign sin cos tan asin acos atan sinh
        cosh tanh exp log log2 log10 cbrt pow atan2 hypot max(2) min(2) random
        asinh acosh atanh expm1 log1p fround f16round clz32 imul
        + constants PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2  (C libm backed)
Number: isInteger isFinite isNaN isSafeInteger parseFloat parseInt, Number(x)
        coercion, constants MAX_SAFE_INTEGER MIN_SAFE_INTEGER MAX_VALUE MIN_VALUE
        EPSILON.  Global parseInt / parseFloat / isNaN / isFinite.
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
        works on parsed results)
Promise: constructor executor, resolve/reject/all/race/allSettled/any,
        then/catch/finally.
RegExp: literal/object/const-string constructor objects with optional QuickJS
        fallback; test/exec/search/match/matchAll/replace/global replaceAll/split,
        captures, named groups, basic `d` indices, `u`/`v` Unicode mode, extracted
        test/exec method values.
Fetch/Web subset: optional libcurl-backed fetch, Response.text/json/status/ok/
        headers, simplified Headers, AbortController/AbortSignal.timeout.
(plus .length for string/array, .size for Map/Set.)

Math single-arg functions are emitted inline as libm calls (sqrt(x), sin(x)...);
two-arg/JS-specific ones (round half-up, sign, trunc, max/min/hypot) use runtime
helpers. Link with -lm. JS `/` is always float division and `%` is fmod, EXCEPT
`intLocal % nonzeroIntConstant` which stays integer-fast (no FPE; hot `% C` loops
keep native speed).

Map/Set are runtime containers (TS_KIND_MAP/SET) with parallel key/value arrays,
linear-probe SameValueZero equality, insertion-order iteration, and full GC
integration (mark traverses keys/vals/elems; sweep frees the arrays). Iterable
constructor seeding is supported for the common array/iterator paths. Callbacks
for map/filter/forEach/reduce and Map/Set.forEach are first-class closures
invoked via ts_call, which prepends the closure's captured environment.

## NOT yet implemented (rejected loudly)
- String: substr, localeCompare, toLocaleString, full Intl locale casing beyond
  the currently guarded default + Turkish/Azeri `toLocaleUpperCase` /
  `toLocaleLowerCase`, and remaining string-pattern RegExp consumers outside the
  const-pattern paths.
- Array: toLocaleString and locale-aware element formatting.
- Map/Set: ES2023 Set algebra methods such as union, intersection, difference,
  symmetricDifference, isSubsetOf/isSupersetOf/isDisjointFrom.
- Object/Symbol reflection: remaining symbol-keyed reflection beyond own-key
  discovery and descriptors.
- Math: newer proposal methods if targeted.
- Number: toLocaleString; POSITIVE_INFINITY / NEGATIVE_INFINITY constants are not
  emitted as JSON constants yet.
- Date: string/Date argument parsing, setters, toString/toUTCString/toLocale*
  formatting, and other formatting helpers.
- JSON.stringify replacer function/array semantics.
- RegExp: dynamic pattern/flags construction and first-class global
  `RegExp`/`globalThis.RegExp` value entry remain rejected; non-global
  `matchAll`/`replaceAll` are rejected at export time instead of becoming a
  runtime TypeError.
- Web/fetch: streaming request/response bodies, abort events, real DOMException
  objects, and full Web-compatible Headers/Request/Response semantics.
- WeakMap / WeakSet / WeakRef / FinalizationRegistry, Reflect, Proxy,
  ArrayBuffer / DataView / TypedArray, Intl, and module value import/export
  linkage are outside the current implemented surface.
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


## Field-name table & enumeration (方針B)
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
