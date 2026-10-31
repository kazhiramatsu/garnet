#!/usr/bin/env python3
"""Classify a conformance log of test262 programs: scripts/test262/summary.py <log> [--top N]
export: a compile-time reject (loud); aot-*: the program ran and differs from V8 (silent or a crash)."""
import collections, re, sys
log, top = sys.argv[1], int(sys.argv[3]) if len(sys.argv) > 3 else 25
kinds = collections.Counter(); reasons = collections.Counter(); dirs = collections.Counter(); samples = {}
total = None
for line in open(log, errors="replace"):
    m = re.match(r"\[conf:\S+\] PASS=(\d+) FAIL=(\d+) / (\d+)", line)
    if m: total = tuple(map(int, m.groups())); continue
    m = re.match(r"\[conf\] FAIL (\S+?): (.*)", line)
    if m:
        slug, rest = m.groups()
        if rest.startswith("AOT=["):
            aot = re.match(r"AOT=\[(.*?)\] V8=\[", rest).group(1) if re.match(r"AOT=\[(.*?)\] V8=\[", rest) else rest
            k = "aot-crash" if "Segmentation" in rest or "Bus error" in rest or "Abort" in rest or "signal" in aot else "aot-timeout" if "TIMEOUT" in aot else "aot-diff"
            why = re.sub(r"\d+", "N", aot)[:70]
        else:
            k = rest.split()[0].rstrip(":")
            why = rest[:80]
        kinds[k] += 1
        reasons[(k, why)] += 1
        dirs["/".join(slug.split("__")[:3])] += 1
        samples.setdefault((k, why), slug)
    elif line.startswith("  - ") or "UNSUPPORTED" in line and False:
        reasons[("reject", re.sub(r" at /.*", "", line.strip())[:90])] += 1
if total: print(f"PASS {total[0]}  FAIL {total[1]}  of {total[2]}")
for k, v in kinds.most_common(): print(f"{v:7} {k}")
print("-- by reason")
for (k, why), v in reasons.most_common(top): print(f"{v:7} {k:12} {why}   e.g. {samples.get((k, why), '')}")
print("-- by directory")
for d, v in dirs.most_common(top): print(f"{v:7} {d}")
