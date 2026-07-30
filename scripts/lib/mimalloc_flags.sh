#!/usr/bin/env bash
# Source from harness scripts after ROOT and CC are set. When
# TSAOT_USE_MIMALLOC=1, append the compile/link flags needed to route runtime and
# generated-C allocations through mimalloc. The repository-owned source is
# preferred and compiled into a cached static object. External discovery also
# accepts only a static libmimalloc archive so a Garnet executable never gains a
# mimalloc DSO dependency by accident. Explicit TSAOT_MIMALLOC_LIBS remains an
# expert override.

unset TSAOT_MIMALLOC_ACTIVE
unset TSAOT_MIMALLOC_VENDOR_ACTIVE

if [[ "${TSAOT_USE_MIMALLOC:-0}" == "1" ]]; then
  if [[ "${CC:-}" == *"-fsanitize=address"* ]]; then
    echo "[mimalloc] disabled for AddressSanitizer build"
  else
    mi_cflags="${TSAOT_MIMALLOC_CFLAGS:-}"
    mi_libs="${TSAOT_MIMALLOC_LIBS:-}"
    mi_source="explicit"

    # An explicit prefix overrides the vendored source. This is useful for
    # allocator experiments without changing the repository-owned version.
    if [[ -z "$mi_libs" && -n "${TSAOT_MIMALLOC_PREFIX:-}" ]]; then
      mi_prefix="$TSAOT_MIMALLOC_PREFIX"
      if [[ -f "$mi_prefix/include/mimalloc.h" &&
            -f "$mi_prefix/lib/libmimalloc.a" ]]; then
        mi_cflags="-I$mi_prefix/include"
        mi_libs="$mi_prefix/lib/libmimalloc.a -pthread"
        mi_source="prefix"
      fi
    fi

    # Default path: build the pinned repository copy as one upstream-supported
    # static translation unit and cache the object by compiler command,
    # platform, and architecture. The mtime check invalidates it after any
    # vendored source update.
    mi_vendor="${TSAOT_MIMALLOC_VENDOR_DIR:-$ROOT/third_party/mimalloc}"
    if [[ -z "$mi_libs" &&
          -f "$mi_vendor/include/mimalloc.h" &&
          -f "$mi_vendor/src/static.c" ]]; then
      mi_build_dir="$ROOT/build/mimalloc"
      mkdir -p "$mi_build_dir"
      mi_section_cflags="-ffunction-sections -fdata-sections"
      # Upstream prints __DATE__/__TIME__ in verbose diagnostics. Pin them so
      # the cached object and final executable are reproducible, and so
      # reproducibility-enforcing cross compilers (notably zig cc) accept it.
      mi_repro_cflags='-Wno-builtin-macro-redefined -D__DATE__="redacted" -D__TIME__="00:00:00"'
      # Ask the compiler instead of uname so cross-compilation from macOS to
      # Linux selects the target linker's option.
      mi_target_macros="$($CC -dM -E -x c /dev/null 2>/dev/null || true)"
      case "$mi_target_macros" in
        *"__APPLE__"*) mi_gc_link_flag="-Wl,-dead_strip" ;;
        *"__linux__"*|*"__FreeBSD__"*) mi_gc_link_flag="-Wl,--gc-sections" ;;
        *) mi_gc_link_flag="" ;;
      esac
      mi_cache_key="$(
        printf '%s\n' "$CC|$mi_section_cflags|$mi_repro_cflags|$mi_gc_link_flag|$(uname -s)|$(uname -m)" |
          cksum | awk '{print $1}'
      )"
      mi_object="$mi_build_dir/mimalloc-$mi_cache_key.o"
      mi_stale=0
      if [[ ! -f "$mi_object" ]]; then
        mi_stale=1
      elif [[ "${BASH_SOURCE[0]}" -nt "$mi_object" ]]; then
        mi_stale=1
      elif [[ -n "$(find "$mi_vendor/include" "$mi_vendor/src" -type f \
                         -newer "$mi_object" -print -quit)" ]]; then
        mi_stale=1
      fi
      if [[ "$mi_stale" == "1" ]]; then
        mi_tmp="$mi_build_dir/.mimalloc-$mi_cache_key.$$"
        # shellcheck disable=SC2086
        if ! $CC -pthread $mi_section_cflags $mi_repro_cflags \
             -I"$mi_vendor/include" \
             -c "$mi_vendor/src/static.c" \
             -o "$mi_tmp.o"; then
          rm -f "$mi_tmp.o"
          return 1
        fi
        mv "$mi_tmp.o" "$mi_object"
      fi
      mi_cflags="-I$mi_vendor/include"
      mi_libs="$mi_object -pthread $mi_gc_link_flag"
      mi_source="vendored"
      TSAOT_MIMALLOC_VENDOR_ACTIVE=1
      export TSAOT_MIMALLOC_VENDOR_ACTIVE
    fi

    # Compatibility fallback for source-only distributions that intentionally
    # omit third_party/mimalloc.
    if [[ -z "$mi_libs" ]]; then
      if command -v pkg-config >/dev/null 2>&1; then
        pc_cflags="$(pkg-config --cflags mimalloc 2>/dev/null || true)"
        pc_libdir="$(pkg-config --variable=libdir mimalloc 2>/dev/null || true)"
        pc_archive="${pc_libdir:+$pc_libdir/libmimalloc.a}"
        pc_static_libs="$(pkg-config --libs --static mimalloc 2>/dev/null || true)"
        if [[ -f "$pc_archive" ]]; then
          # Preserve private dependencies such as -lpthread, but replace
          # -L... -lmimalloc with the archive's absolute path. Merely using
          # pkg-config --static does not force a static archive when a DSO is
          # installed next to it.
          pc_private=""
          for pc_arg in $pc_static_libs; do
            case "$pc_arg" in
              -L*|-lmimalloc|*/libmimalloc.a) ;;
              *) pc_private="$pc_private $pc_arg" ;;
            esac
          done
          [[ -n "$mi_cflags" ]] || mi_cflags="$pc_cflags"
          mi_libs="$pc_archive$pc_private"
          mi_source="pkg-config"
        fi
      fi
    fi

    if [[ -z "$mi_libs" ]]; then
      prefixes=()
      prefixes+=("/opt/homebrew/opt/mimalloc" "/usr/local/opt/mimalloc" "/opt/homebrew" "/usr/local" "/usr")
      for p in "${prefixes[@]}"; do
        [[ -f "$p/include/mimalloc.h" ]] || continue
        if [[ -f "$p/lib/libmimalloc.a" ]]; then
          [[ -n "$mi_cflags" ]] || mi_cflags="-I$p/include"
          mi_libs="$p/lib/libmimalloc.a -pthread"
          mi_source="system-prefix"
          break
        fi
      done
    fi

    if [[ -z "$mi_libs" ]]; then
      echo "[mimalloc] TSAOT_USE_MIMALLOC=1 but neither vendored source nor static libmimalloc.a was found." >&2
      echo "[mimalloc] Restore third_party/mimalloc, install the mimalloc development package," >&2
      echo "[mimalloc] set TSAOT_MIMALLOC_PREFIX," >&2
      echo "[mimalloc] or opt out with TSAOT_USE_MIMALLOC=0." >&2
      return 1
    fi

    CC="$CC -DTSAOT_USE_MIMALLOC $mi_cflags"
    TSAOT_LDLIBS="${TSAOT_LDLIBS:-} $mi_libs"
    export CC TSAOT_LDLIBS TSAOT_MIMALLOC_ACTIVE=1
    echo "[mimalloc] enabled ($mi_source): cflags=[$mi_cflags] libs=[$mi_libs]"
  fi
fi
