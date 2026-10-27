#!/usr/bin/env python3
# Reads a macOS `sample` call graph (the profile of a real-project driver built with `garnet --profile`,
# docs/real_projects.md) and prints the shares a flat view hides: inclusive samples by symbol, the
# self samples under one subtree by leaf, the callers of a symbol aggregated by chain, its callees,
# and the tree of a subtree above a sample threshold (Session 355).
import re, sys, collections
f, mode = sys.argv[1], sys.argv[2]
lines = open(f).read().split("\n")
# the call-graph section: lines between "Call graph:" and "Total number in stack"
try:
    s = lines.index("Call graph:") + 1
except ValueError:
    s = 0
e = next((i for i, l in enumerate(lines) if l.startswith("Total number in stack")), len(lines))
pat = re.compile(r"^([ +!:|]*)(\d+) (.*?)  \(in (.*?)\)")
stack = []  # (depth, sym)
nodes = []  # (depth, count, sym, parent_index)
for l in lines[s:e]:
    m = pat.match(l)
    if not m: continue
    depth = len(m.group(1)); cnt = int(m.group(2)); sym = m.group(3)
    while stack and stack[-1][0] >= depth: stack.pop()
    parent = stack[-1][1] if stack else -1
    nodes.append((depth, cnt, sym, parent))
    stack.append((depth, len(nodes) - 1))
def chain(i):
    out = []
    while i >= 0:
        out.append(nodes[i][2]); i = nodes[i][3]
    return out
if mode == "incl":
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    incl = collections.Counter()
    for i, (d, c, sym, p) in enumerate(nodes):
        # count a node's samples once per distinct symbol on its chain (no double counting of recursion)
        seen = set()
        j = i
        while j >= 0:
            if nodes[j][2] not in seen:
                seen.add(nodes[j][2])
            j = nodes[j][3]
        # only leaf nodes carry self samples: self = count - sum(children)
    children = collections.defaultdict(int)
    for i, (d, c, sym, p) in enumerate(nodes):
        if p >= 0: children[p] += c
    for i, (d, c, sym, p) in enumerate(nodes):
        self_c = c - children[i]
        if self_c <= 0: continue
        for sname in set(chain(i)):
            incl[sname] += self_c
    for sym, c in incl.most_common(n): print(f"{c:6d} {sym}")
elif mode == "callers":
    target = sys.argv[3]; depth = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    agg = collections.Counter()
    children = collections.defaultdict(int)
    for i, (d, c, sym, p) in enumerate(nodes):
        if p >= 0: children[p] += c
    for i, (d, c, sym, p) in enumerate(nodes):
        if sym != target: continue
        # samples inside this node not attributed to a deeper occurrence of target
        sub = c
        ch = chain(i)[1:depth+1]
        agg[" <- ".join(ch)] += c
    tot = 0
    for k, c in agg.most_common(25): print(f"{c:6d} {target} <- {k}")
elif mode == "callees":
    target = sys.argv[3]; n = int(sys.argv[4]) if len(sys.argv) > 4 else 25
    agg = collections.Counter(); selfc = 0
    children = collections.defaultdict(int)
    for i, (d, c, sym, p) in enumerate(nodes):
        if p >= 0: children[p] += c
    for i, (d, c, sym, p) in enumerate(nodes):
        if p >= 0 and nodes[p][2] == target: agg[sym] += c
        if sym == target: selfc += c - children[i]
    print(f"self {selfc}")
    for k, c in agg.most_common(n): print(f"{c:6d} {k}")
if mode == "tree":
    thr = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    start = sys.argv[4] if len(sys.argv) > 4 else None
    base = None
    for i, (d, c, sym, p) in enumerate(nodes):
        if start and base is None:
            if sym == start: base = d
            else: continue
        if start and d < base: break
        if c >= thr: print("  " * ((d - (base or 0)) // 2) + f"{c} {sym}")
if mode == "selfcallers":
    targets = sys.argv[3].split(","); depth = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    children = collections.defaultdict(int)
    for i, (d, c, sym, p) in enumerate(nodes):
        if p >= 0: children[p] += c
    for target in targets:
        agg = collections.Counter(); tot = 0
        for i, (d, c, sym, p) in enumerate(nodes):
            if sym != target: continue
            sc = c - children[i]
            if sc <= 0: continue
            tot += sc
            agg[" <- ".join(chain(i)[1:depth+1])] += sc
        print(f"## {target}: self {tot}")
        for k, c in agg.most_common(12): print(f"  {c:5d} <- {k}")
if mode == "leaves":
    root = sys.argv[3]; n = int(sys.argv[4]) if len(sys.argv) > 4 else 40
    children = collections.defaultdict(int)
    for i, (d, c, sym, p) in enumerate(nodes):
        if p >= 0: children[p] += c
    agg = collections.Counter(); tot = 0
    for i, (d, c, sym, p) in enumerate(nodes):
        sc = c - children[i]
        if sc <= 0 or root not in chain(i): continue
        agg[sym] += sc; tot += sc
    print(f"self samples under {root}: {tot}")
    for k, c in agg.most_common(n): print(f"{c:6d} {k}")
