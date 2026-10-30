#!/usr/bin/env python3
# The time of each compiled JS function in macOS `sample` reports of a garnet binary: every sample is
# attributed to the innermost compiled function on its stack (fn_<N>_<name>[_d]), the runtime it
# calls included, which is what V8's --cpu-prof reports as a JS function's self time (V8 inlines
# most of what garnet's runtime does). Compare with scripts/node_cpuprof_functions.py on the same
# workload; the functions with the largest ratio are the targets (Session 360 found vue's getLoc at
# six times V8's time this way).
#   sample <pid> 2 1 -f run1.txt ...; python3 scripts/sample_js_functions.py run1.txt run2.txt [--top N]
import sys, re, collections
args = sys.argv[1:]
top = 30
if "--top" in args:
    i = args.index("--top"); top = int(args[i + 1]); del args[i:i + 2]
acc = collections.Counter(); total = 0
for f in args:
    s = open(f).read()
    if "Call graph:" not in s: continue
    lines = s.split("Call graph:")[1].split("Total number in stack")[0].splitlines()
    nodes = []
    for ln in lines:
        m = re.match(r"^([\s+!:|]*)(\d+)\s+(.+?)\s+\(in ", ln)
        if m: nodes.append((len(m.group(1)), int(m.group(2)), m.group(3)))
    n = len(nodes); stack = []
    for i, (d, c, name) in enumerate(nodes):
        while stack and stack[-1][0] >= d: stack.pop()
        stack.append((d, name))
        kids = 0; j = i + 1; kd = None
        while j < n and nodes[j][0] > d:
            if kd is None: kd = nodes[j][0]
            if nodes[j][0] == kd: kids += nodes[j][1]
            j += 1
        sc = c - kids
        if sc <= 0: continue
        js = None
        for _, nm in reversed(stack):
            m2 = re.match(r"^fn_\d+_(.+?)(_d)?$", nm)
            if m2: js = m2.group(1); break
        if js is None:
            if any("ulock" in nm for _, nm in stack): continue   # other threads' waits
            js = "(no js frame)"
        acc[js] += sc; total += sc
print("samples", total)
for k, v in acc.most_common(top): print(f"{v:6d} {100 * v / max(total, 1):5.1f}% {k}")
