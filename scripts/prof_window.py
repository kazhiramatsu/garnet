#!/usr/bin/env python3
"""prof_window.py <raw samples> <from ms> <to ms> <out pcs>: the samples of one window of a
profiled run (TSAOT_PROF_PC_RAW, times in microseconds since the sampler started) aggregated
into the pcs format of scripts/prof_pc.py (pc count image symbol+off lr lr2). The windows come
from the program's timeline (tsc-ts: TSC_TS_TIMELINE=1, marks in ms since the process started;
the sampler starts at the first allocation, a few ms later, so the edges are approximate)."""
import sys, collections
raw, t0, t1, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
lines = open(raw).read().split('\n')
rows = collections.Counter(); names = {}
for l in lines[2:]:
    p = l.split()
    if len(p) < 6: continue
    t_ms = int(p[0]) / 1000.0
    if t_ms < t0 or t_ms >= t1: continue
    key = (p[1], p[4], p[5]); rows[key] += 1; names[key] = (p[2], p[3])
with open(out, 'w') as f:
    f.write(lines[0] + '\n'); f.write(f"samples {sum(rows.values())}\n")
    for (pc, lr, lr2), c in sorted(rows.items()):
        img, sym = names[(pc, lr, lr2)]
        f.write(f"{pc} {c} {img} {sym} {lr} {lr2}\n")
print(f"{sum(rows.values())} samples in [{t0}, {t1}) ms -> {out}")
