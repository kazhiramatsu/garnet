# Vendored mimalloc

This directory contains the source subset required to build mimalloc as part of
Garnet.

- Upstream: https://github.com/microsoft/mimalloc
- Version: `v3.3.2`
- Upstream commit: `30b2d9d89099bee08e9f67a1ffb3e12e7ba45227`
- Source archive:
  `https://github.com/microsoft/mimalloc/releases/download/v3.3.2/mimalloc-v3.3.2-source.tar.gz`
- SHA-256:
  `7ced84a659a95454ce08b725af56331164e6b8673310e5a9a5c612576145456f`
- License: MIT; see `LICENSE`.

The upstream `include/` and `src/` files have only trailing whitespace and
end-of-file newlines normalized to satisfy Garnet's repository checks.
Generated documentation, project files, tests, and prebuilt binaries are
intentionally excluded. Garnet compiles `src/static.c`, the upstream-supported
single-source entry point with per-function/data sections, caches the target
object under `build/mimalloc/`, and enables the platform linker's
dead-section elimination. The build pins mimalloc's diagnostic `__DATE__` and
`__TIME__` values so the object remains reproducible. Linking the object directly
also avoids requiring a target-aware `ar` when cross-compiling.

To update the dependency:

1. Verify the new release and its checksum.
2. Replace `LICENSE`, `include/`, and `src/` from the source release.
3. Remove documentation and Windows tracing manifest files not required by
   `src/static.c`.
4. Update the version, commit, URL, and checksum above.
5. Run `tests/mimalloc_static_link_gate.sh`, the runtime unit tests with
   `TSAOT_USE_MIMALLOC=1`, and `scripts/ci_fast.sh`.
