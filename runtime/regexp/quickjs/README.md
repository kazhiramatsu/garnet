# QuickJS vendored RegExp sources

This directory holds the upstream QuickJS files used by tsaot's optional
RegExp fallback module.

The preferred upstream release is the official QuickJS `2025-09-13` source
tarball, `quickjs-2025-09-13-2.tar.xz`. QuickJS-NG-style tarballs are also
accepted if they contain `libregexp.c`, `libunicode.c`, `cutils.h`, and the
matching headers/tables.

Use:

```sh
bash scripts/vendor_quickjs_regexp.sh
```

If network access is unavailable, download the tarball separately and run:

```sh
TSAOT_QUICKJS_TARBALL=/path/to/quickjs-2025-09-13-2.tar.xz \
  bash scripts/vendor_quickjs_regexp.sh
```

The script copies only the files needed by the RegExp/unicode fallback into
`upstream/` and writes an import manifest. `VERSION` and `cutils.c` are copied
when present, but are not required for source layouts where `cutils.h` contains
the needed inline helpers. Keep the upstream `LICENSE` beside the copied source
files.

The optional RegExp adapter is still responsible for hiding QuickJS internals
from `runtime/ts_rt.c`; tsaot strings remain Latin1/UTF-16 views and adapter
positions remain UTF-16 code-unit indices.
