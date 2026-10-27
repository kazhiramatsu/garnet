#!/usr/bin/env bash
# The A/B of two builds of a real-project driver (docs/real_projects.md): the binaries alternate for
# `runs` rounds inside the project's clone (a driver's relative paths name the project's files), each
# run's time is the first "N ms" the driver prints on stderr, and the medians are printed. Alternating
# on the same machine state is what makes a few percent readable; absolute numbers drift with the load.
#   cd build/real/<name> && bash ../../../benchmarks/real/ab.sh ../<name>-work/driver.v0 ../<name>-work/driver.v1 [runs]
A=$1; B=$2; N=${3:-5}
ta=(); tb=()
for i in $(seq "$N"); do
  ta+=("$("$A" 2>&1 >/dev/null | grep -o '[0-9.]* ms' | head -1 | cut -d' ' -f1)")
  tb+=("$("$B" 2>&1 >/dev/null | grep -o '[0-9.]* ms' | head -1 | cut -d' ' -f1)")
done
med() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
echo "A $(basename "$A"): ${ta[*]} -> median $(med "${ta[@]}")"
echo "B $(basename "$B"): ${tb[*]} -> median $(med "${tb[@]}")"
