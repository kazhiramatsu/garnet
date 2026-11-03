#!/usr/bin/env python3
# A differential fuzzer for the numeric facts: small programs of number functions (recursion on a counter, loops, calls
# between them, constants at single call sites), where whole-program integer and range inference has something to believe.
import random, sys
CONSTS = ["0","1","2","3","5","7","8","16","31","100","255","256","1024","65536","-1","-3","-7","0.5","1.5","-2.5","2147483647","2147483648","-2147483648","4294967295","4294967296","4294967297","1e21","1e-7"]
BIN = ["+","-","*","/","%","&","|","^","<<",">>",">>>"]
CMP = ["<","<=",">",">=","===","!=="]
def expr(r, vs, depth, fns):
    if depth <= 0 or r.random() < 0.25:
        return r.choice(vs) if vs and r.random() < 0.7 else r.choice(CONSTS)
    k = r.random()
    d = depth - 1
    if k < 0.55:
        return f"({expr(r,vs,d,fns)} {r.choice(BIN)} {expr(r,vs,d,fns)})"
    if k < 0.62:
        return f"(({expr(r,vs,d,fns)} as number) {r.choice(CMP)} {expr(r,vs,d,fns)} ? {expr(r,vs,d,fns)} : {expr(r,vs,d,fns)})"
    if k < 0.72:
        f = r.choice(["Math.floor","Math.abs","Math.trunc","Math.ceil","Math.round","Math.sign"])
        return f"{f}({expr(r,vs,d,fns)})"
    if k < 0.78:
        f = r.choice(["Math.min","Math.max","Math.imul"])
        return f"{f}({expr(r,vs,d,fns)}, {expr(r,vs,d,fns)})"
    if k < 0.84:
        return f"(-({expr(r,vs,d,fns)}))"
    if k < 0.88:
        return f"(~({expr(r,vs,d,fns)}))"
    if fns:
        name, arity = r.choice(fns)
        return f"{name}({', '.join(expr(r,vs,d,fns) for _ in range(arity))})"
    return f"({expr(r,vs,d,fns)} | 0)"
def function(r, i, fns):
    arity = r.randint(1, 3)
    ps = [f"p{j}" for j in range(arity)]
    head = f"function f{i}({', '.join(p + ': number' for p in ps)}): number"
    kind = r.random()
    if kind < 0.45:   # recursion on a counter
        n = ps[0]
        rec = ", ".join([f"{n} - 1"] + [expr(r, ps, 2, fns) for _ in ps[1:]])
        step = r.choice(BIN)
        body = expr(r, ps, 2, fns)
        form = r.random()
        guard = r.choice([f"!({n} > 0 && {n} <= 64)", f"!({n} >= 1 && {n} < 32)"])
        if form < 0.4:
            s = f"return {guard} ? {expr(r, ps, 1, fns)} : f{i}({rec});"
        elif form < 0.8:
            s = f"return {guard} ? {expr(r, ps, 1, fns)} : (f{i}({rec}) {step} {body});"
        else:
            s = f"if ({guard}) return {expr(r, ps, 1, fns)};\n  const r = f{i}({rec});\n  return r {step} {body};"
        return head + " {\n  " + s + "\n}\n", (f"f{i}", arity), True
    if kind < 0.75:   # a loop
        t = r.randint(1, 6)
        s = f"let s = {expr(r, ps, 2, fns)};\n  for (let i = 0; i < {t}; i++) {{\n    s = {expr(r, ps + ['s', 'i'], 3, fns)};\n  }}\n  return s;"
        return head + " {\n  " + s + "\n}\n", (f"f{i}", arity), False
    if kind < 0.87:   # locals
        s = f"const a = {expr(r, ps, 2, fns)};\n  let b = {expr(r, ps + ['a'], 2, fns)};\n  if (({expr(r, ps + ['a'], 1, fns)} as number) {r.choice(CMP)} b) b = {expr(r, ps + ['a', 'b'], 2, fns)};\n  return {expr(r, ps + ['a', 'b'], 3, fns)};"
        return head + " {\n  " + s + "\n}\n", (f"f{i}", arity), False
    return head + f" {{ return {expr(r, ps, 3, fns)}; }}\n", (f"f{i}", arity), False
def program(seed):
    r = random.Random(seed)
    out, fns, recs = [], [], {}
    for i in range(r.randint(3, 7)):
        text, sig, rec = function(r, i, fns)
        out.append(text); fns.append(sig); recs[sig[0]] = rec
    lines = []
    for name, arity in fns:
        for _ in range(r.choice([1, 1, 1, 2])):
            args = []
            for j in range(arity):
                args.append(str(r.randint(0, 6)) if j == 0 and recs[name] else r.choice(CONSTS))
            lines.append(f"console.log(\"{name}\", 1, {name}({', '.join(args)}));")
    return "".join(out) + "\n".join(lines) + "\n"
if __name__ == "__main__":
    print(program(int(sys.argv[1])), end="")
