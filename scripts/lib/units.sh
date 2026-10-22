#!/usr/bin/env bash
# Build a program the emitter wrote as units (`tsaot <ir> emit --units <dir>`,
# docs/build_split_design.md): every unit compiled in parallel, the largest
# first, each object cached by a hash of its unit, the shared header as the
# compiler sees it (preprocessed, with its macros) and the compile command,
# then one link. Units are ThinLTO bitcode by default, so calls between units
# are still inlined at link time; the cold units (the giant run-once
# functions) are native objects at -O0. Source this file.
#
#   tsaot_units_build <unit-dir> <output> [objects or link arguments...]
#
# Environment:
#   TSAOT_UNITS_CC      compile command for the units (default "cc -O2")
#   TSAOT_UNITS_CFLAGS  extra compile arguments (include paths, -include, -D)
#   TSAOT_UNITS_LTO     1 (default): ThinLTO; 0: native objects, plain link
#   TSAOT_UNITS_JOBS    parallel compiles (default: the CPU count)
#   TSAOT_UNITS_CACHE   object and LTO cache directory (default build/unit-cache)
#   TSAOT_UNITS_CACHE_DAYS  cache entries unused this many days are removed (default 7)

tsaot_units_build() {
  local dir="$1" out="$2"; shift 2
  local root; root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  local cc="${TSAOT_UNITS_CC:-cc -O2}"
  local cflags="${TSAOT_UNITS_CFLAGS:-}"
  local lto="${TSAOT_UNITS_LTO:-1}"
  local jobs="${TSAOT_UNITS_JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)}"
  local cache="${TSAOT_UNITS_CACHE:-$root/build/unit-cache}"
  mkdir -p "$cache"
  local ltoflag="" coldflag="-O0"
  [[ "$lto" == "1" ]] && ltoflag="-flto=thin"
  # GlobalISel's passes are quadratic on the giant cold functions (clang, AArch64)
  if $cc -O0 -fno-global-isel -x c -c /dev/null -o /dev/null 2>/dev/null; then coldflag="-O0 -fno-global-isel"; fi
  local ccver; ccver="$($cc --version 2>&1 | head -1)"
  # the header as the compiler sees it: every header it includes, every macro
  $cc $cflags -E -P -dD -x c "$dir/prog.h" -o "$dir/.prog.i" || return 1
  local hhash; hhash="$(shasum -a 256 "$dir/.prog.i" | cut -c1-64)"
  rm -f "$dir/.prog.i"
  # one compile script: the cache lookup, the compile, the store
  cat > "$dir/.cc_unit.sh" <<EOF
#!/usr/bin/env bash
set -eu
f="\$1"
case "\$f" in cold_*) opt="$coldflag";; *) opt="$ltoflag";; esac
key=\$( { printf '%s\n' "$hhash" "$cc $cflags" "\$opt" "$ccver"; cat "\$f"; } | shasum -a 256 | cut -c1-64)
obj="$cache/\$key.o"
if [[ -f "\$obj" ]]; then
  touch "\$obj"
else
  $cc $cflags \$opt -c "\$f" -o "\$obj.\$\$.tmp" 2> "\$f.err" || { echo "[units] FAIL \$f"; head -20 "\$f.err"; exit 1; }
  mv -f "\$obj.\$\$.tmp" "\$obj"
fi
ln -f "\$obj" "\${f%.c}.o" 2>/dev/null || cp -f "\$obj" "\${f%.c}.o"
EOF
  chmod +x "$dir/.cc_unit.sh"
  ( cd "$dir" && ls -S *.c | xargs -P "$jobs" -n 1 ./.cc_unit.sh ) || return 1
  local objs=()
  local f
  for f in "$dir"/*.c; do objs+=("${f%.c}.o"); done
  local days="${TSAOT_UNITS_CACHE_DAYS:-7}"
  local linklto=()
  if [[ "$lto" == "1" ]]; then
    linklto=(-flto=thin)
    case "$(uname -s)" in
      Darwin) linklto+=("-Wl,-cache_path_lto,$cache/lto" "-Wl,-prune_after_lto,$((days * 86400))") ;;
      *) linklto+=("-Wl,--thinlto-cache-dir=$cache/lto") ;;
    esac
  fi
  # the link takes the optimization level from the compile command (ThinLTO
  # backends); bash 3.2 rejects an empty array's "${a[@]}" under set -u
  $cc $cflags ${linklto[@]+"${linklto[@]}"} "${objs[@]}" "$@" -o "$out" || return 1
  # a hit refreshes an object's time; what no build used for a while goes
  find "$cache" -maxdepth 1 -name '*.o' -mtime +"$days" -delete 2>/dev/null
  return 0
}
