#!/usr/bin/env bash
# Source from harness scripts after ROOT and CC are set. When
# TSAOT_USE_MIMALLOC=1, append the compile/link flags needed to route runtime and
# generated-C allocations through mimalloc.

if [[ "${TSAOT_USE_MIMALLOC:-0}" == "1" ]]; then
  if [[ "${CC:-}" == *"-fsanitize=address"* ]]; then
    echo "[mimalloc] disabled for AddressSanitizer build"
  else
    mi_cflags="${TSAOT_MIMALLOC_CFLAGS:-}"
    mi_libs="${TSAOT_MIMALLOC_LIBS:-}"

    if [[ -z "$mi_cflags" || -z "$mi_libs" ]]; then
      if command -v pkg-config >/dev/null 2>&1; then
        pc_cflags="$(pkg-config --cflags mimalloc 2>/dev/null || true)"
        pc_libs="$(pkg-config --libs mimalloc 2>/dev/null || true)"
        if [[ -n "$pc_libs" ]]; then
          mi_cflags="$pc_cflags"
          mi_libs="$pc_libs"
        fi
      fi
    fi

    if [[ -z "$mi_cflags" || -z "$mi_libs" ]]; then
      prefixes=()
      [[ -n "${TSAOT_MIMALLOC_PREFIX:-}" ]] && prefixes+=("$TSAOT_MIMALLOC_PREFIX")
      prefixes+=("/opt/homebrew/opt/mimalloc" "/usr/local/opt/mimalloc" "/opt/homebrew" "/usr/local" "/usr")
      for p in "${prefixes[@]}"; do
        [[ -f "$p/include/mimalloc.h" ]] || continue
        if compgen -G "$p/lib/libmimalloc.*" >/dev/null; then
          mi_cflags="-I$p/include"
          mi_libs="-L$p/lib -lmimalloc"
          break
        fi
      done
    fi

    if [[ -z "$mi_cflags" || -z "$mi_libs" ]]; then
      echo "[mimalloc] TSAOT_USE_MIMALLOC=1 but mimalloc was not found." >&2
      echo "[mimalloc] Install it or set TSAOT_MIMALLOC_CFLAGS/TSAOT_MIMALLOC_LIBS." >&2
      return 1
    fi

    CC="$CC -DTSAOT_USE_MIMALLOC $mi_cflags"
    TSAOT_LDLIBS="${TSAOT_LDLIBS:-} $mi_libs"
    export CC TSAOT_LDLIBS TSAOT_MIMALLOC_ACTIVE=1
    echo "[mimalloc] enabled: cflags=[$mi_cflags] libs=[$mi_libs]"
  fi
fi
