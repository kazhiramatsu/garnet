#!/usr/bin/env python3
# Delta reduction of a program that differs from Node: whole functions and classes, then top-level lines; a removal stays when
# the program still compiles and still differs.   python3 scripts/fuzz/reduce.py build/fuzz/found/numbers105.ts
import os, subprocess, sys, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
def split(src):
    parts, cur = [], []
    for line in src.splitlines():
        if line.startswith(("function ", "class ")):
            cur = [line]
            if line.rstrip().endswith("}") and line.startswith("function "):
                parts.append("\n".join(cur)); cur = []
        elif cur:
            cur.append(line)
            if line == "}":
                parts.append("\n".join(cur)); cur = []
        else:
            parts.append(line)
    return parts
def differs(parts, d):
    ts_file = os.path.join(d, "rd.ts")
    open(ts_file, "w").write("\n".join(parts) + "\n")
    built = subprocess.run([os.path.join(ROOT, "garnet"), "-o", os.path.join(d, "rd.c"), ts_file], capture_output=True, text=True)
    if built.returncode != 0:
        return False
    a = subprocess.run(["perl", "-e", "alarm 10; exec @ARGV", os.path.join(d, "rd")], capture_output=True, text=True).stdout
    subprocess.run(["node", os.path.join(ROOT, "scripts/fuzz/transpile.js"), ts_file])
    b = subprocess.run(["node", os.path.join(d, "rd.mjs")], capture_output=True, text=True).stdout
    return a != b
parts = split(open(sys.argv[1]).read())
with tempfile.TemporaryDirectory() as d:
    if not differs(parts, d):
        sys.exit("no difference to begin with")
    changed = True
    while changed:
        changed = False
        for i in range(len(parts) - 1, -1, -1):
            t = parts[:i] + parts[i + 1:]
            if t and differs(t, d):
                parts = t; changed = True
    # then line by line, a balanced chunk at a time: what does not compile is refused by `differs`
    lines = "\n".join(parts).splitlines()
    size = max(len(lines) // 4, 1)
    while size >= 1:
        i = len(lines) - size
        while i >= 0:
            t = lines[:i] + lines[i + size:]
            if t and differs(t, d):
                lines = t
            i -= size
        size //= 2
    print("\n".join(lines))
