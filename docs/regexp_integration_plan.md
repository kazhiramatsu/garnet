# RegExp Integration Plan

RegExp support should not turn tsaot into a general JavaScript VM. The AOT
compiler should keep the common no-RegExp output small, and only pull the
RegExp fallback module into generated programs that actually use RegExp.

## Engine Choice

Use QuickJS `libregexp` plus `libunicode` as the full-semantics fallback.

- `libregexp` is ECMAScript-oriented and already handles the hard parts of JS
  RegExp semantics: backtracking bytecode, captures, Unicode properties, and the
  flag surface.
- `libunicode` should be vendored with it, but kept as a RegExp semantic table,
  not as a replacement for tsaot's string representation.
- PCRE/RE2-style engines are not a good primary fallback because their semantics
  differ from ECMAScript, especially around captures, backreferences, Unicode,
  and JavaScript-specific flags.

## AOT Loading Rule

No-RegExp programs must emit and link no RegExp support.

The intended split is:

- `runtime/ts_rt.c` / `ts_rt.h`: core runtime, always linked.
- `runtime/regexp/`: vendored QuickJS regexp/unicode files plus a small tsaot
  adapter, linked only when generated C needs RegExp.
- generated C marker: when the exporter/analyzer accepts a RegExp operation,
  emit `#define TSAOT_NEEDS_REGEXP 1` and include `regexp/ts_regexp_adapter.h`.
- harness/link step: when the generated C contains the marker, add the RegExp
  module objects. Otherwise keep the current link path.

`tests/regexp_aot_gate.sh` guards the current no-RegExp case by checking that a
program using only string literal search/replace emits no RegExp/QuickJS support.

## QuickJS Vendoring

The preferred upstream source is the official QuickJS release tarball
`quickjs-2025-09-13-2.tar.xz`. The current checkout has imported
`quickjs-0.15.1.tar.gz`, which has a QuickJS-NG-style layout: it contains
`cutils.h` but no `cutils.c` or top-level `VERSION` file. `libregexp.c` and
`libunicode.c` compile successfully in that layout.

Vendoring scaffold:

- `runtime/regexp/quickjs/`: QuickJS import boundary and instructions.
- `runtime/regexp/quickjs/upstream/`: copied upstream files, once imported.
- `scripts/vendor_quickjs_regexp.sh`: copies the required upstream files from
  either the official URL or a local tarball specified with
  `TSAOT_QUICKJS_TARBALL=/path/to/quickjs-2025-09-13-2.tar.xz`.

Required files are `LICENSE`, `cutils.h`, `libregexp.c/h`,
`libregexp-opcode.h`, `libunicode.c/h`, `libunicode-table.h`, and `list.h`.
`VERSION` and `cutils.c` are copied when present. The current shell sandbox
cannot resolve `bellard.org`, so source import was run from a locally supplied
tarball.

## String Boundary

QuickJS internals must not leak into the general string runtime.

- tsaot strings stay Latin1/UTF-16 `ts_strview` values.
- RegExp adapter input/output positions are UTF-16 code-unit indices.
- literal/prefix fast paths use `ts_str_find_forward_view` /
  `ts_str_find_backward_view` and do not call QuickJS.
- full fallback converts or presents input to QuickJS only inside the adapter.

The runtime helper `ts_regexp_litprefix_find_view` is the first shared scanner
contract. It takes `ts_strview` source/prefix, a start code-unit index, and a
sticky flag; it returns start/end code-unit indices on match. The current
`/literal/.test(x)` and `string.search(/literal/)` fast paths use this scanner
without constructing a RegExp object.

## Exporter Pipeline

Keep the current loud rejects until a path is implemented end-to-end.

1. Classify regex literals with `classifyRegExpLiteral`.
2. If the pattern is a plain literal-prefix candidate, keep metadata for an AOT
   fast path.
3. If the operation needs full semantics, mark the program as needing RegExp and
   route to the QuickJS adapter.
4. If neither path is available, reject at export time.

The classifier is intentionally conservative. It extracts a prefix from simple
literals and escaped literal characters, records `^`, `g`, `y`, `i`, and Unicode
mode flags, and stops at char classes, groups, quantifiers, alternatives, and
non-literal escapes.

## Implementation Order

1. Keep boundary tests passing: unsupported RegExp entry points reject, and
   no-RegExp programs emit no RegExp support. DONE.
2. Add the optional `runtime/regexp/` boundary with README/license guidance and a
   narrow adapter API. DONE; QuickJS `libregexp` / `libunicode` source is
   vendored under `runtime/regexp/quickjs/upstream`.
3. Implement `RegExp` object representation in tsaot runtime: source, flags,
   lastIndex, compiled fallback handle, and optional literal-prefix metadata.
   PARTIAL: regex literal objects allocate a normal object with source/flags/
   lastIndex and hidden metadata. Native bytecode is not stored on the heap
   object; the adapter owns an immortal source+flags cache instead.
4. Enable regex literal construction for plain literals only; `test` and
   `search` should be first because they need minimal result materialization.
   DONE: direct literal call sites are lowered without object construction when
   possible, and QuickJS fallback covers regex sources outside the scanner fast
   path.
5. Add `exec` / `match` captures, then `replace` / `split`, then named groups and
   full replacement expansion. DONE for the current literal/object fallback
   surface, including function replacers, basic `d` indices, named groups,
   `$<name>` replacement, and `matchAll` iterator results.
6. Broaden AOT fast paths only after conformance exists for `g`, `y`, `lastIndex`,
   empty matches, Unicode mode, and ignore-case behavior.

## Current State

- Exact literal-prefix `/literal/.test(x)`, `string.search(/literal/)`,
  `const r=/literal/; r.test(x)`, and `string.search(r)` are accepted when the
  classifier reaches `end` and the `i` flag is absent.
- Direct regex literal `.test`, `.exec`, `string.search(/.../)`,
  `string.match(/.../)`, `string.matchAll(/.../g)`, `replace` / global
  `replaceAll`, and `string.split(/.../)` use `ts_regexp_adapter_test_tsv` /
  `ts_regexp_adapter_exec_tsv` / `ts_regexp_adapter_search_tsv` /
  `ts_regexp_adapter_match_tsv` / `ts_regexp_adapter_match_all_tsv` /
  `ts_regexp_adapter_replace_tsv` / `ts_regexp_adapter_split_tsv` when the
  pattern is outside the literal-prefix scanner path. The adapter converts
  tsaot's JS UTF-16 code-unit strings to QuickJS `libregexp` source bytes the
  same way QuickJS does: CESU-8 for non-`u` regexps, normal UTF-8 code points
  for `u` regexps. This covers the initial QuickJS fallback surface for `i`,
  captures, quantifiers, groups, alternation, anchors, and non-ASCII literals
  without constructing a RegExp object.
- Plain RegExp literal objects expose `source`, `flags`, and writable
  `lastIndex`; `.test` and `.exec` implement the narrow `g`/`y` lastIndex
  update/reset behavior. Literal-prefix objects use the AOT scanner. Other
  accepted literal objects carry a hidden flag mask and use the optional QuickJS
  fallback for `.test`, `.exec`, `string.search(r)`, `string.match(r)`,
  `string.matchAll(r)`,
  `replace` / global `replaceAll` with string or function replacers, and
  `string.split(r)`. Basic `d` flag `.indices` are materialized for `.exec`
  and non-global `match`; named groups are materialized on `.groups`,
  `.indices.groups`, function replacer `groups`, and `$<name>` replacement.
  `matchAll` returns a protocol iterator and starts object regexps from the
  original `lastIndex` without mutating it.
  Native bytecode is cached inside the adapter by QuickJS-compatible source
  bytes + flags, not stored on the heap object. `String(r)`, template
  substitution, `r.toString()`, console inspect, and
  `Object.prototype.toString.call(r)` are covered for these objects.
- Extracted `r.test` / `r.exec` method values, `RegExp(...)`, `new RegExp(...)`,
  `RegExp` value reads, static `globalThis.RegExp` access, and string-pattern
  `match`/`search` reject loudly.
- `ts_regexp_litprefix_find_view` is available for future fast paths and covered
  by runtime unit tests.
- `classifyRegExpLiteral` is available in the exporter and covered by
  `tests/regexp_classifier.sh`.
- Generated C emits `TSAOT_NEEDS_REGEXP` only for accepted RegExp operations.
  `scripts/lib/regexp_link_flags.sh` and `tests/regexp_link_gate.sh` guard optional
  adapter linkage; `tests/regexp_aot_gate.sh` keeps no-RegExp programs clean.
- QuickJS vendoring is present under `runtime/regexp/quickjs/upstream`.
  `scripts/lib/regexp_link_flags.sh` compiles and links `libunicode.o` and
  `libregexp.o` only for generated C with `TSAOT_NEEDS_REGEXP`.
- The QuickJS adapter owns compile/free/exec wrappers around `lre_compile` and
  `lre_exec`, including Latin1 and UTF-16 input entry points. Generated-C
  high-level helpers use an adapter-owned source+flags bytecode cache rather
  than storing native pointers on RegExp heap objects.
