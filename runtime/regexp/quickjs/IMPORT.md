# QuickJS import

- Version: 0.15.1
- Tarball: quickjs-0.15.1.tar.gz
- Source: QuickJS-NG 0.15.1 — https://github.com/quickjs-ng/quickjs (release tarball quickjs-0.15.1.tar.gz)
- SHA-256: c4e813951b7c46845096a948e978c620b11ab4cf5fd622ca09c727ec31f42623
- Imported files:
  - LICENSE
  - cutils.h
  - libunicode.c
  - libunicode.h
  - libunicode-table.h

Only the optional Unicode runtime (runtime/unicode) may include these files (libregexp was removed in Session 357). Do not include
QuickJS headers from `runtime/ts_rt.c`.
