# tsaot optional Unicode runtime

This directory is the boundary for Unicode String API support that should only
be linked into programs that actually use those APIs.

Current files:

- `ts_unicode_adapter.h` / `ts_unicode_adapter.c`: tsaot-facing adapter surface.
  When compiled with the vendored QuickJS `libunicode` headers, it wraps
  `unicode_normalize()` / `lre_case_conv()` and exposes
  `String.prototype.normalize`, `toUpperCase`, `toLowerCase`,
  `toLocaleUpperCase`, and `toLocaleLowerCase` entry points. Locale casing uses
  the default QuickJS case table plus scoped Turkish/Azeri special casing.
  The adapter converts tsaot strings from ECMAScript UTF-16 code-unit storage to
  code points for QuickJS normalization, then converts the result back to UTF-16.
  Valid surrogate pairs become one scalar code point; lone surrogates are
  preserved as lone code units.

Generated C should include this module only when it emits
`#define TSAOT_NEEDS_UNICODE 1`. Normal no-Unicode programs must not include this
header or link this object. If a program also needs RegExp, the linker helper
shares the single vendored `libunicode.o` object between RegExp and Unicode
adapters.
