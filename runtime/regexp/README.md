# tsaot optional RegExp runtime

This directory is the boundary for RegExp support that should only be linked
into programs that actually use RegExp.

The planned full fallback engine is QuickJS `libregexp` plus `libunicode`. The
vendoring scaffold lives in `quickjs/`; run `scripts/vendor_quickjs_regexp.sh`
to copy the required upstream files from the official QuickJS source tarball.
If this environment has no network access, download the tarball separately and
run the script with `TSAOT_QUICKJS_TARBALL=/path/to/tarball`.

Current files:

- `ts_regexp_adapter.h` / `ts_regexp_adapter.c`: tsaot-facing adapter surface.
  When compiled with vendored QuickJS headers, it wraps `lre_compile` /
  `lre_exec`, owns compiled bytecode, and exposes generated-C entry points for
  direct literal `.test` / `.exec` / `search` / `match` / `matchAll` fallback
  plus RegExp object `.test` / `.exec` / `search` / `match` / `matchAll`
  fallback, and
  `replace` / global `replaceAll` with string or function replacers, `split`,
  basic `d` flag `.indices`, and named group fallback.
  Generated-C entry points use an adapter-owned immortal cache keyed by
  QuickJS-compatible source bytes + flags, so RegExp heap objects do not need
  native finalizers yet. The generated-C entry points mirror QuickJS's
  pattern-source conversion:
  non-`u` regexps preserve UTF-16 code units as CESU-8, while `u` regexps encode
  surrogate pairs as normal UTF-8 code points. The public header intentionally
  does not include `ts_rt.h`, because generated C already includes it first.
- `quickjs/`: vendored upstream QuickJS regexp/unicode files and import
  metadata.

Generated C should include this module only when it emits
`#define TSAOT_NEEDS_REGEXP 1`. Normal no-RegExp programs must not include this
header or link this object.
