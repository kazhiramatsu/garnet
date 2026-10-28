#!/usr/bin/env bash
# Optional RegExp linker helper. Source this after ROOT/CC are set.

TSAOT_REGEXP_OBJS=()
TSAOT_REGEXP_OBJ_ARGS=""
TSAOT_REGEXP_QUICKJS_DIR=""
TSAOT_UNICODE_OBJS=()
TSAOT_UNICODE_OBJ_ARGS=""
TSAOT_UNICODE_QUICKJS_DIR=""
TSAOT_FETCH_RT_OBJ_ARG=""
TSAOT_FETCH_LDLIBS=""

tsaot_c_needs_regexp() {
  local cfile="$1"
  grep -q '^#define TSAOT_NEEDS_REGEXP 1' "$cfile"
}

tsaot_c_needs_unicode() {
  local cfile="$1"
  grep -q '^#define TSAOT_NEEDS_UNICODE 1' "$cfile"
}

tsaot_c_needs_fetch() {
  local cfile="$1"
  grep -q '^#define TSAOT_NEEDS_FETCH 1' "$cfile"
}

tsaot_quickjs_unicode_vendor_available() {
  local qjs="$ROOT/runtime/regexp/quickjs/upstream"
  [[ -f "$qjs/libunicode.c" && -f "$qjs/libunicode.h" &&
     -f "$qjs/libunicode-table.h" && -f "$qjs/cutils.h" ]]
}

tsaot_obj_list_contains() {
  local needle="$1"; shift
  local obj
  for obj in "$@"; do
    [[ "$obj" == "$needle" ]] && return 0
  done
  return 1
}

tsaot_prepare_regexp_objs() {
  # The regexp engine (runtime/regexp/rx_engine.c: parser, compiler, VM, Unicode tables) and the
  # adapter (the RegExp objects and the String / RegExp methods), docs/regexp_vm_design.md. Both
  # objects are rebuilt when any file under runtime/regexp or the runtime header is newer.
  local cfile="$1"
  local work="$2"
  TSAOT_REGEXP_OBJS=()
  TSAOT_REGEXP_OBJ_ARGS=""
  TSAOT_REGEXP_QUICKJS_DIR=""
  if ! tsaot_c_needs_regexp "$cfile"; then
    return 0
  fi
  local outdir="$work/regexp"
  mkdir -p "$outdir"
  local src="$ROOT/runtime/regexp"
  local eng="$outdir/rx_engine.o"
  local ad="$outdir/ts_regexp_adapter.o"
  if [[ ! -f "$eng" || -n "$(find "$src" -maxdepth 1 \( -name '*.c' -o -name '*.h' \) -newer "$eng" -print -quit)" ]]; then
    $CC -c "$src/rx_engine.c" -I"$src" -o "$eng" || return 1
  fi
  if [[ ! -f "$ad" || -n "$(find "$src" "$ROOT/runtime/ts_rt.h" -maxdepth 1 \( -name '*.c' -o -name '*.h' \) -newer "$ad" -print -quit)" ]]; then
    $CC -c "$src/ts_regexp_adapter.c" -I"$ROOT/runtime" -I"$src" -o "$ad" || return 1
  fi
  TSAOT_REGEXP_OBJS=("$eng" "$ad")
  TSAOT_REGEXP_OBJ_ARGS="${TSAOT_REGEXP_OBJS[*]}"
}

tsaot_prepare_unicode_objs() {
  local cfile="$1"
  local work="$2"
  TSAOT_UNICODE_OBJS=()
  TSAOT_UNICODE_OBJ_ARGS=""
  TSAOT_UNICODE_QUICKJS_DIR=""
  if ! tsaot_c_needs_unicode "$cfile"; then
    return 0
  fi
  local outdir="$work/unicode"
  mkdir -p "$outdir"
  local obj="$outdir/ts_unicode_adapter.o"
  if tsaot_quickjs_unicode_vendor_available; then
    TSAOT_UNICODE_QUICKJS_DIR="$ROOT/runtime/regexp/quickjs/upstream"
  fi
  if [[ ! -f "$obj" ]]; then
    if [[ -n "$TSAOT_UNICODE_QUICKJS_DIR" ]]; then
      $CC -c "$ROOT/runtime/unicode/ts_unicode_adapter.c" \
        -DTSAOT_HAS_QUICKJS_UNICODE=1 \
        -I"$ROOT/runtime" -I"$ROOT/runtime/unicode" -I"$TSAOT_UNICODE_QUICKJS_DIR" -o "$obj" || return 1
    else
      $CC -c "$ROOT/runtime/unicode/ts_unicode_adapter.c" \
        -I"$ROOT/runtime" -I"$ROOT/runtime/unicode" -o "$obj" || return 1
    fi
  fi
  TSAOT_UNICODE_OBJS=("$obj")
  if [[ -n "$TSAOT_UNICODE_QUICKJS_DIR" ]]; then
    local qjs_outdir="$work/quickjs"
    mkdir -p "$qjs_outdir"
    local unicode_obj="$qjs_outdir/libunicode.o"
    if [[ ! -f "$unicode_obj" ]]; then
      $CC -c "$TSAOT_UNICODE_QUICKJS_DIR/libunicode.c" \
        -I"$TSAOT_UNICODE_QUICKJS_DIR" -o "$unicode_obj" || return 1
    fi
    if [[ " $TSAOT_REGEXP_OBJ_ARGS " != *" $unicode_obj "* ]]; then
      TSAOT_UNICODE_OBJS+=("$unicode_obj")
    fi
  fi
  TSAOT_UNICODE_OBJ_ARGS="${TSAOT_UNICODE_OBJS[*]}"
}

tsaot_prepare_fetch_runtime() {
  local cfile="$1"
  local work="$2"
  local default_rt_obj="${3:-}"
  TSAOT_FETCH_RT_OBJ_ARG="$default_rt_obj"
  TSAOT_FETCH_LDLIBS=""
  if ! tsaot_c_needs_fetch "$cfile"; then
    return 0
  fi
  local outdir="$work/fetch"
  mkdir -p "$outdir"
  local obj="$outdir/ts_rt_fetch.o"
  if [[ ! -f "$obj" ]]; then
    $CC -c "$ROOT/runtime/ts_rt.c" -DTSAOT_ENABLE_FETCH=1 \
      -I"$ROOT/runtime" -o "$obj" || return 1
  fi
  TSAOT_FETCH_RT_OBJ_ARG="$obj"
  TSAOT_FETCH_LDLIBS="-lcurl"
}
