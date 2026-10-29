#!/usr/bin/env bash
# The A/B of two hono driver builds over all four routers (benchmarks/real/ab.sh reads the first
# line only): the binaries alternate for `runs` rounds inside the clone, each router's time is its
# "<name>: N ms" line on stderr, and the medians are printed per router.
#   cd build/real/hono && bash ../../../benchmarks/real/ab4.sh ../hono-work/driver.v0 ../hono-work/driver.v1 [runs]
A=$1; B=$2; N=${3:-5}
declare -a names=(TrieRouter RegExpRouter PatternRouter SmartRouter)
ta=(); tb=()
for i in $(seq "$N"); do
  ta+=("$("$A" 2>&1 >/dev/null | grep -o '^[A-Za-z]*: [0-9.]* ms' | tr '\n' ' ')")
  tb+=("$("$B" 2>&1 >/dev/null | grep -o '^[A-Za-z]*: [0-9.]* ms' | tr '\n' ' ')")
done
med() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
for r in "${names[@]}"; do
  va=(); vb=()
  for i in $(seq 0 $((N-1))); do va+=("$(echo "${ta[$i]}" | grep -o "$r: [0-9.]*" | cut -d' ' -f2)"); vb+=("$(echo "${tb[$i]}" | grep -o "$r: [0-9.]*" | cut -d' ' -f2)"); done
  echo "$r: A $(basename "$A") ${va[*]} -> $(med "${va[@]}") | B $(basename "$B") ${vb[*]} -> $(med "${vb[@]}")"
done
