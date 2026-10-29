#!/usr/bin/env bash
# Profile-guided builds by convention (docs/pgo_design.md): a `default.pgo`
# next to a program's entry file is applied to every build of it, the way Go
# applies a main package's default.pgo. Source this file after ROOT is set.
#
#   tsaot_pgo_profdata             print the llvm-profdata command, or fail
#   tsaot_pgo_supported <cc>       succeed when <cc> is clang (the only compiler
#                                  whose profile format these helpers handle)
#   tsaot_pgo_use_flags <profile>  compile and link flags that apply a profile;
#                                  functions the profile does not know keep their
#                                  plain optimization, silently
#   tsaot_pgo_gen_flags <dir>      compile and link flags of an instrumented
#                                  build that writes raw profiles into <dir>
#   tsaot_pgo_merge <dir> <out>    merge <dir>/*.profraw into the profile <out>
#   tsaot_pgo_train <cmd> <bin> <dir> <out>
#                                  run the training command with TSAOT_PGO_BIN set
#                                  to the instrumented executable (also its $1),
#                                  the raw profiles going to <dir>, then merge;
#                                  the program's run-time regexps are recorded
#                                  in <dir>/regexps.txt (TSAOT_REGEXP_RECORD)
#   tsaot_regexps_write <dir> <out>  the record's distinct patterns, sorted, as
#                                  <out> (default.regexps); with no pattern
#                                  recorded a stale <out> is removed and the
#                                  function fails
#   tsaot_regexps_table <tsaot> <regexps> <cc> <dir> <out var>
#                                  write and compile the table of their native
#                                  matchers into <dir>/rx_table.o (the engine's
#                                  headers on the include path); the object's
#                                  path in <out var>, empty when there is none

tsaot_pgo_profdata() {
  if [[ -n "${TSAOT_LLVM_PROFDATA:-}" ]]; then echo "$TSAOT_LLVM_PROFDATA"; return 0; fi
  if command -v llvm-profdata >/dev/null 2>&1; then echo llvm-profdata; return 0; fi
  local p
  p="$(${CC:-cc} -print-prog-name=llvm-profdata 2>/dev/null || true)"
  if [[ -n "$p" && "$p" != "llvm-profdata" && -x "$p" ]]; then echo "$p"; return 0; fi
  if command -v xcrun >/dev/null 2>&1 && xcrun -f llvm-profdata >/dev/null 2>&1; then echo "xcrun llvm-profdata"; return 0; fi
  p="$(ls /usr/bin/llvm-profdata-* /usr/lib/llvm-*/bin/llvm-profdata 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$p" ]]; then echo "$p"; return 0; fi
  echo "[pgo] llvm-profdata not found (set TSAOT_LLVM_PROFDATA)" >&2
  return 1
}

tsaot_pgo_supported() {
  $1 --version 2>/dev/null | head -1 | grep -qi clang
}

tsaot_pgo_use_flags() {
  echo "-fprofile-use=$1 -Wno-profile-instr-unprofiled -Wno-profile-instr-out-of-date -Wno-backend-plugin"
}

tsaot_pgo_gen_flags() {
  echo "-fprofile-generate=$1"
}

tsaot_pgo_merge() {
  local dir="$1" out="$2" pd
  pd="$(tsaot_pgo_profdata)" || return 1
  local raws=("$dir"/*.profraw)
  if [[ ! -f "${raws[0]}" ]]; then
    echo "[pgo] the training run wrote no profile into $dir (did it run the instrumented executable, \$TSAOT_PGO_BIN?)" >&2
    return 1
  fi
  $pd merge -output="$out" "${raws[@]}"
}

tsaot_pgo_train() {
  local cmd="$1" bin="$2" dir="$3" out="$4"
  mkdir -p "$dir"
  rm -f "$dir"/*.profraw
  rm -f "$dir/regexps.txt"
  if ! (export TSAOT_PGO_BIN="$bin" LLVM_PROFILE_FILE="$dir/%p.profraw" TSAOT_REGEXP_RECORD="$dir/regexps.txt"; bash -c "$cmd" bash "$bin"); then
    echo "[pgo] the training command exited non-zero; the profile it wrote is used anyway" >&2
  fi
  tsaot_pgo_merge "$dir" "$out"
}

tsaot_regexps_write() {
  local dir="$1" out="$2" n
  if [[ -s "$dir/regexps.txt" ]]; then
    n="$(grep -v '^#' "$dir/regexps.txt" | sort -u | grep -c .)"
    { echo "# garnet: the $n regular expression(s) the program built at run time during the training run (docs/regexp_vm_design.md): flags, the pattern as hex UTF-16 code units, the source"
      grep -v '^#' "$dir/regexps.txt" | sort -u; } > "$out"
    return 0
  fi
  if [[ -f "$out" ]]; then echo "[pgo] the training run built no regular expression at run time: $out removed" >&2; rm -f "$out"; fi
  return 1
}

tsaot_regexps_table() {
  local tsaot="$1" regexps="$2" cc="$3" dir="$4" var="$5"
  printf -v "$var" ''
  [[ -n "$regexps" && -f "$regexps" ]] || return 0
  mkdir -p "$dir"
  "$tsaot" regexps "$regexps" > "$dir/rx_table.c" || { echo "[regexps] tsaot regexps failed on $regexps" >&2; return 1; }
  grep -q rx_tbl_install "$dir/rx_table.c" || return 0
  $cc -c "$dir/rx_table.c" -I"$ROOT/runtime/regexp" -o "$dir/rx_table.o" || { echo "[regexps] the matcher table did not compile ($dir/rx_table.c)" >&2; return 1; }
  printf -v "$var" '%s' "$dir/rx_table.o"
}
