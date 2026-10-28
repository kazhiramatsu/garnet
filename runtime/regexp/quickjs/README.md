# QuickJS vendored sources (libunicode)

`upstream/` holds QuickJS's `libunicode.c` / `libunicode.h` / `libunicode-table.h` and
`cutils.h`, used by `runtime/unicode/ts_unicode_adapter.c` (String `normalize`, locale case
mapping), linked only into programs whose generated C declares `TSAOT_NEEDS_UNICODE`.
The regular expression engine is garnet's own (`..`, `docs/regexp_vm_design.md`); libregexp
was removed in Session 357.

Refresh with `bash scripts/vendor_quickjs_regexp.sh` (the official QuickJS tarball, or
`TSAOT_QUICKJS_TARBALL=/path/to/tarball` offline); keep the upstream `LICENSE` beside the
copied files. `runtime/ts_rt.c` must not include QuickJS headers.
