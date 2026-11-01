#!/usr/bin/env python3
"""Classify the logs of scripts/test262/run.sh: scripts/test262/summary.py <out dir> [--top N] [--dir PREFIX]

A case passes when it prints nothing (or the async harness's completion line) and exits; a negative case when
the compile refuses it or the run throws the expected error. Otherwise, by what garnet did:
  reject     the compile stopped (loud)        wrong    ran, and differs from V8
  crash      killed by a signal                timeout  killed by the watchdog
  v8-also    V8 fails as well in this harness (a sloppy-only case in a strict module, a host hook)
  no-eval    needs code from strings at run time, which a compiled program has no engine for"""
import collections, glob, os, re, sys
out = sys.argv[1]
top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 30
prefix = sys.argv[sys.argv.index("--dir") + 1] if "--dir" in sys.argv else ""
meta = {}
for f in glob.glob(os.path.join(out, "*.meta")):
    for line in open(f, errors="replace"):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 5: meta[p[0]] = p
kinds = collections.Counter(); reasons = collections.Counter(); dirs = collections.defaultdict(collections.Counter); samples = {}; feats = collections.Counter()
OK = ("", "Test262:AsyncTestComplete|")
def note(slug, kind, why=""):
    if prefix and not slug.startswith(prefix): return
    kinds[kind] += 1
    dirs["/".join(slug.split("__")[:3])][kind] += 1
    if why:
        reasons[(kind, why)] += 1
        samples.setdefault((kind, why), slug)
    if kind in ("wrong", "crash", "timeout", "reject"):
        m = meta.get(slug)
        if m:
            for x in m[4].split(","):
                if x: feats[x] += 1
for log in sorted(glob.glob(os.path.join(out, "*.log"))):
    pending = None; v8_refused = False
    for line in open(log, errors="replace"):
        line = line.rstrip("\n")
        if pending and line.startswith("  ["):
            why = re.sub(r"^\s*\[\S+\]\s*-?\s*", "", line); why = re.sub(r" at /.*", "", why)[:90]
            m = meta.get(pending)
            if m and m[2]: note(pending, "pass")
            elif v8_refused: note(pending, "v8-also")
            else: note(pending, "reject", why)
            pending = None
            continue
        if pending:
            m = meta.get(pending)
            if m and m[2]: note(pending, "pass")
            else: note(pending, "reject", "(no reason line)")
            pending = None
        m = re.match(r"\[conf\] PASS (\S+)\s+\((.*)\)$", line)
        if m:
            slug, o = m.groups()
            n = meta.get(slug)
            if n and n[2]:
                note(slug, "pass" if n[3] and n[3] in o else "wrong" if o in OK else "v8-also", "" if o not in OK else "accepted a negative case")
            elif o in OK: note(slug, "pass")
            else: note(slug, "v8-also", re.sub(r"\d+", "N", o)[:70])
            continue
        m = re.match(r"\[conf\] FAIL (\S+?): (.*)", line)
        if not m: continue
        slug, rest = m.groups()
        if rest.startswith("export"):
            pending = slug; v8_refused = "SyntaxError" in rest; continue
        a = re.match(r"AOT=\[(.*)\] V8=\[(.*)\]$", rest)
        if not a:
            note(slug, "reject", rest[:80]); continue
        aot, v8 = a.groups()
        n = meta.get(slug)
        if n and n[2]:
            note(slug, "pass" if n[3] and n[3] in aot else "wrong", "" if n[3] and n[3] in aot else "negative: " + re.sub(r"\d+", "N", aot)[:60]); continue
        short = re.sub(r"\d+", "N", aot.replace("tsaot: Uncaught exception: ", ""))[:70]
        if "eval is not defined" in aot or "Code generation from strings" in aot or (n and len(n) > 5 and n[5] == "eval"):
            note(slug, "no-eval"); continue
        sig = re.search(r"\[signal (\d+)\]", aot)
        if sig: note(slug, "timeout" if sig.group(1) == "14" else "crash", "signal " + sig.group(1) + ": " + short)
        elif v8 not in OK: note(slug, "v8-also")
        else: note(slug, "wrong", short)
    if pending: note(pending, "reject", "(no reason line)")
total = sum(kinds.values())
print("total", total, " ".join(f"{k}={v}" for k, v in kinds.most_common()))
print("-- by reason")
for (k, why), v in reasons.most_common(top): print(f"{v:7} {k:8} {why}   e.g. {samples[(k, why)]}")
print("-- by directory (not passing)")
rows = sorted(dirs.items(), key=lambda kv: -sum(v for k, v in kv[1].items() if k != "pass"))
for d, c in rows[:top]: print(f"{sum(c.values()):7} {d:48} " + " ".join(f"{k}={v}" for k, v in c.most_common()))
print("-- features of the failures")
for f, v in feats.most_common(top): print(f"{v:7} {f}")
