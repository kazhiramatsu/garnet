# Dynamic property keys without ToString

Session 350, build `x66`. Runtime (`ts_rt.c`).

## Finding

A computed property access (`obj[k]`, `k in obj`, `obj.hasOwnProperty(k)`,
`delete obj[k]`) on an ordinary object converts the key value to the
runtime's key id (`ts_key_from_value`): ToString, then a UTF-8 copy of the
string in a fresh heap buffer, the intern table lookup, and a free. For a
number key ToString also allocates the string. In the compiler this costs
2.4% of the samples (inclusive): `forEachChildTable[node.kind]` (a table
keyed by syntax kinds, 1.1%), `isNodeArray`'s `hasOwnProperty("pos")` /
`("end")` (0.5%), `Debug[name]`.

## Change

- **Small integers** (0 to 4095, -0 included): a table of their interned
  decimal keys, filled on first use; other integers below 2^53 are
  formatted on the stack (`ts_i64_to_str`). Other numbers keep ToString.
- **String literals** (static strings: never freed, identity is stable):
  a direct-mapped cache by value identity (1,024 entries).
- **Other strings** intern without a heap copy (`ts_intern_view`): an ASCII
  string's own bytes, a string up to 64 code units converted into a stack
  buffer, a longer one through the old copy.
- `TSAOT_KEY_CACHES=0` turns the two caches off (the stack conversion
  stays: same keys either way).

## Results

A tsc-style kernel (`forEachChildTable[node.kind]` and `hasOwnProperty`
with literals, 3M keyed reads): 138 -> 61 ms with the caches (same binary,
`TSAOT_KEY_CACHES=0` against the default). The compiler (`x65`'s compiled
code relinked with the runtime): 4.221 vs 4.310 s and 4.230 vs 4.327 s
median, all six pairs faster, about -2.1%.

## Gates

Fixture `objects/dynamic_keys` (number keys: 0, 1, -0, -5, 4095, 4096,
65536, 1e21, 1.5, NaN, the infinities, 2^53, a sum with a rounding tail;
a table keyed by kinds read in a loop; literal and computed strings meeting
at one key; non-ASCII, a surrogate pair, a lone surrogate, keys of 64, 70
and 80 units; symbols; counting by number keys at one site), also with
`TSAOT_KEY_CACHES=0`; conformance, GC stress; the compiler's A/B.
