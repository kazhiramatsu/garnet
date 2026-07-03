# QuickJS import

- Version: 0.15.1
- Tarball: quickjs-0.15.1.tar.gz
- Source URL: local:/Users/hiramatsu/Downloads/quickjs-0.15.1.tar.gz
- SHA-256: c4e813951b7c46845096a948e978c620b11ab4cf5fd622ca09c727ec31f42623
- Imported files:
  - LICENSE
  - cutils.h
  - libregexp.c
  - libregexp.h
  - libregexp-opcode.h
  - libunicode.c
  - libunicode.h
  - libunicode-table.h
  - list.h

Only the optional RegExp runtime may include these files. Do not include
QuickJS headers from `runtime/ts_rt.c`.
