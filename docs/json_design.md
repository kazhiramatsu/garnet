# JSON + field-name table (Approach B)

## Goal
Implement `JSON.stringify` and `JSON.parse` faithfully, including stringifying
ordinary objects (not just Map), and as a side benefit unlock `Object.keys/
values/entries`. The enabling piece is a runtime **field-id <-> name table**.

## The core problem
Object properties are stored under interned field-id keys (uint32), not string
names. The compiler interns each property name to a stable id in `program.fields`
(id -> name). For `JSON.stringify(obj)` / `Object.keys(obj)` we must recover the
string names; for `JSON.parse` producing an object whose fields are later read by
dot access (`JSON.parse(s).foo`), the produced keys must match the SAME ids the
compiler assigned to those names.

## Design

### 1. Emit the field-name table into the C output
`emit_c` emits, from `program.fields`:
```c
static const char* const FIELD_NAMES[] = { "__value", "__date_ms", "x", "y", ... };
static const uint32_t FIELD_NAMES_COUNT = N;
```
indexed by field id (the exporter assigns ids densely from 0). At startup
`ts_init_fields(FIELD_NAMES, FIELD_NAMES_COUNT)` seeds the runtime table.

### 2. Runtime field table (ts_rt)
- `ts_field_name(id)` -> const char* (NULL if id >= count or id is internal).
- `ts_intern_field(name, len)` -> uint32 id. Looks up the seeded table; if the
  name is unknown (a key only seen in JSON at runtime), appends a fresh id beyond
  the static count and returns it. This keeps runtime-parsed keys consistent and
  lets JSON round-trip, while names the compiler knew keep their compile-time id
  so dot access works.
- "enumerable" predicate: a key is an own enumerable string property iff
  `id < METHOD_KEY_BASE` (1_000_000) AND its name is non-NULL AND does not start
  with "__" (internal: __value, __date_ms, ...).

### 3. Object.keys / values / entries
Walk `obj->props`; for each enumerable key push name / value / [name,value].
Returns an array (insertion order, matching prop append order = JS own-key order
for string keys).

### 4. JSON.stringify(value, ?, ?)
Recursive, building a string via a growable buffer:
- number: `%.17g`-ish but matching JS (use the existing number->string), Infinity
  and NaN -> `null` (JS behavior).
- bool -> true/false; null -> null; undefined / function -> omitted (object) or
  `null` (array element).
- string -> quoted with JSON escaping (`\" \\ \n \r \t \b \f`, control chars \uXXXX).
- array -> `[e0,e1,...]` (undefined/function elements -> `null`).
- Map -> `{}` only if keys are strings (we stringify string keys; non-string keys
  are skipped, approximating JS which would use String(key)). 
- plain object -> `{ "name": value, ... }` over enumerable own props.
- cycle / depth: cap recursion depth (e.g. 256) and error via
  ts_unsupported_builtin-style trap to avoid infinite loop. (Full cycle detection
  via a visited set can come later.)
- The optional `replacer` / `space` (pretty-print) args are NOT supported in the
  first cut -> rejected loudly at export if passed.

### 5. JSON.parse(text)
Recursive-descent over the string bytes producing tsv directly:
- object -> a normal ts object; each `"key": value` does
  `ts_set(obj, ts_intern_field(key), value)`. This yields field-id keys
  consistent with compile-time interning, so `JSON.parse(s).foo` works when `foo`
  was used (interned) anywhere in the program; otherwise it still parses (fresh
  runtime id) and is reachable via dynamic access.
- array -> ts array.
- string/number/true/false/null -> the obvious tsv.
- whitespace skipped; malformed input -> trap (JS throws SyntaxError; we abort
  loudly for now). The `reviver` arg is unsupported (rejected at export).

## Internal-structure changes
- ts_object, props, find_slot: unchanged.
- New: a global runtime field table (array of names + a name->id lookup), seeded
  once at startup. Thread-safety not a concern (single-threaded).
- emit_c: new prologue emitting FIELD_NAMES and the ts_init_fields call inside
  the existing startup (where ts_setup_prototypes is called).
- This does not change the value representation or GC; it only adds a static
  metadata table and two runtime helpers, plus JSON/Object builtins.

## Safety
- stringify of a value containing a function or a cycle: functions omitted/`null`
  like JS; cycles -> depth-capped trap (loud, not silent).
- parse of malformed JSON -> loud trap.
- Unsupported options (replacer/space/reviver) -> rejected at export.
