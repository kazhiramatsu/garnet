#!/usr/bin/env python3
# Self time per JS function of a Node --cpu-prof profile (the V8 side of scripts/sample_js_functions.py).
#   node --cpu-prof --cpu-prof-dir=DIR --cpu-prof-interval 250 driver.mjs; python3 scripts/node_cpuprof_functions.py DIR/*.cpuprofile [--top N]
import json, sys, collections
args = sys.argv[1:]
top = 30
if "--top" in args:
    i = args.index("--top"); top = int(args[i + 1]); del args[i:i + 2]
self_t = collections.Counter()
for f in args:
    p = json.load(open(f))
    nodes = {n["id"]: n for n in p["nodes"]}
    for sid, dt in zip(p["samples"], p["timeDeltas"]):
        cf = nodes[sid]["callFrame"]
        self_t[f"{cf['functionName'] or '(anon)'} [{cf['url'].split('/')[-1]}:{cf['lineNumber']}]"] += dt
tot = sum(self_t.values())
print("total ms", tot / 1000)
for k, v in self_t.most_common(top): print(f"{v / 1000:8.1f} ms {100 * v / max(tot, 1):5.1f}% {k}")
