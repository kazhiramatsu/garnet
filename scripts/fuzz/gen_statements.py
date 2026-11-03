#!/usr/bin/env python3
# The second differential fuzzer: statements over number locals, arrays, object literals, class instances and closures,
# where store-proven integer fields, scalar replacement, unboxing and captures have something to believe.
import random, sys
CONSTS = ["0","1","2","3","5","7","10","16","100","255","1024","65536","-1","-3","0.5","1.5","-2.5","0.1","2147483647","-2147483648","4294967296"]
class G:
    def __init__(s, seed):
        s.r = random.Random(seed); s.n = 0; s.classes = []
    def name(s, p):
        s.n += 1; return f"{p}{s.n}"
    def const(s):
        return s.r.choice(CONSTS)
    def smallint(s):
        return str(s.r.choice([0,1,2,3,4,5,7,8,10]))
    def expr(s, e, d):
        r = s.r
        nums = e["nums"]
        if d <= 0 or r.random() < 0.3:
            return r.choice(nums) if nums and r.random() < 0.75 else s.const()
        d -= 1; k = r.random()
        if k < 0.4:
            return f"({s.expr(e,d)} {r.choice(['+','-','*','/','%','+','-','*'])} {s.expr(e,d)})"
        if k < 0.5:
            return f"({s.expr(e,d)} {r.choice(['|','&','^','<<','>>','>>>'])} {s.expr(e,d)})"
        if k < 0.56:
            return f"(({s.expr(e,d)} as number) {r.choice(['<','<=','>','>=','===','!=='])} {s.expr(e,d)} ? {s.expr(e,d)} : {s.expr(e,d)})"
        if k < 0.62:
            return f"{r.choice(['Math.floor','Math.abs','Math.trunc','Math.round'])}({s.expr(e,d)})"
        if k < 0.70 and e["arrs"]:
            a = r.choice(e["arrs"])
            return f"({a}.length > 0 ? ({a}[{s.index(e,a,d)}] ?? -1) : -2)"
        if k < 0.76 and e["arrs"]:
            a = r.choice(e["arrs"])
            return r.choice([f"{a}.length", f"{a}.indexOf({s.expr(e,0)})", f"{a}.reduce((x, y) => x + y, 0)", f"{a}.filter((x) => x > {s.const()}).length"])
        if k < 0.84 and e["objs"]:
            o = r.choice(e["objs"]); return f"{o}.{r.choice(['a','b'])}"
        if k < 0.92 and e["insts"]:
            o, c = r.choice(e["insts"]); m = r.choice(s.classes[c]["reads"])
            return m.replace("@", o).replace("$", s.expr(e, d))
        if k < 0.97 and e["fns"]:
            return f"{r.choice(e['fns'])}({s.expr(e,d)})"
        return f"({s.expr(e,d)} | 0)"
    def index(s, e, a, d):
        return f"Math.abs(({s.expr(e,d)}) | 0) % {a}.length"
    def block(s, e, d, loopy):
        out = []
        env = {k: list(v) for k, v in e.items()}
        for _ in range(s.r.randint(1, 4)):
            out.append(s.stmt(env, d, loopy))
        return "\n".join(x for x in out if x)
    def stmt(s, e, d, loopy):
        r = s.r; k = r.random()
        if k < 0.16:
            v = s.name("v"); x = s.expr(e, 2); e["nums"].append(v); e["muts"].append(v)
            return f"let {v}: number = {x};"
        if k < 0.30 and e["muts"]:
            v = r.choice(e["muts"])
            return f"{v} {r.choice(['=','+=','-=','*=','|=','='])} {s.expr(e,2)};"
        if k < 0.36 and e["arrs"]:
            a = r.choice(e["arrs"])
            return r.choice([f"{a}.push({s.expr(e,1)});", f"if ({a}.length > 0) {a}[{s.index(e,a,0)}] = {s.expr(e,1)};", f"{a}.pop();", f"{a}.sort((x, y) => x - y);", f"{a}.reverse();"])
        if k < 0.42 and e["objs"]:
            o = r.choice(e["objs"])
            return f"{o}.{r.choice(['a','b'])} {r.choice(['=','+='])} {s.expr(e,2)};"
        if k < 0.52 and e["insts"]:
            o, c = r.choice(e["insts"]); m = r.choice(s.classes[c]["writes"])
            return m.replace("@", o).replace("$", s.expr(e, 1)) + ";"
        if k < 0.57:
            a = s.name("arr"); items = ", ".join(s.expr(e, 1) for _ in range(r.randint(0, 4)))
            e["arrs"].append(a); return f"const {a}: number[] = [{items}];"
        if k < 0.62:
            o = s.name("o"); x, y = s.expr(e, 1), s.expr(e, 1)
            e["objs"].append(o); return f"const {o} = {{ a: {x}, b: {y} }};"
        if k < 0.68 and s.classes:
            o = s.name("c"); c = r.randrange(len(s.classes)); args = ", ".join(s.expr(e, 1) for _ in range(s.classes[c]["ctor"]))
            e["insts"].append((o, c))
            return f"const {o} = new {s.classes[c]['name']}({args});"
        if k < 0.73:
            f = s.name("fn"); p = s.name("n")
            inner = {x: list(y) for x, y in e.items()}; inner["nums"] = inner["nums"] + [p]; inner["muts"] = list(inner["muts"])
            body = s.expr(inner, 2)
            cap = r.choice(e["muts"]) if e["muts"] and r.random() < 0.4 else None
            text = f"const {f} = ({p}: number): number => {{ {cap + ' += 1; ' if cap else ''}return {body}; }};"
            e["fns"].append(f); return text
        if d <= 0: return ""
        if k < 0.83:
            c = f"({s.expr(e,1)} as number) {r.choice(['<','>','===','!=='])} {s.expr(e,1)}"
            return f"if ({c}) {{\n{s.block(e,d-1,loopy)}\n}} else {{\n{s.block(e,d-1,loopy)}\n}}"
        if k < 0.91:
            i = s.name("i"); inner = {x: list(y) for x, y in e.items()}; inner["nums"].append(i)
            b = s.block(inner, d-1, True)
            ex = ""
            if r.random() < 0.3:
                ex = f"\nif (({s.expr(inner,1)} as number) > {s.const()}) {r.choice(['break','continue'])};"
            return f"for (let {i} = 0; {i} < {r.randint(1,5)}; {i}++) {{{ex}\n{b}\n}}"
        if k < 0.95:
            cases = "\n".join(f"case {c}: {{\n{s.block(e,d-1,loopy)}\n{r.choice(['break;','break;',''])}\n}}" for c in r.sample([0,1,2,3], 2))
            return f"switch (({s.expr(e,1)}) & 3) {{\n{cases}\ndefault: {{\n{s.block(e,d-1,loopy)}\n}}\n}}"
        t = f"if (({s.expr(e,1)} as number) > 0) throw new Error(\"x\");"
        return f"try {{\n{t}\n{s.block(e,d-1,loopy)}\n}} catch {{\n{s.block(e,d-1,loopy)}\n}} finally {{\n{s.block(e,d-1,loopy)}\n}}"
    def klass(s, i):
        r = s.r; name = f"C{i}"; base = None
        if s.classes and r.random() < 0.3: base = r.randrange(len(s.classes))
        fields = [f"f{i}x", f"f{i}y"]
        init = [r.choice(["0","1","2.5","100"]) for _ in fields]
        par = f" extends {s.classes[base]['name']}" if base is not None else ""
        lines = [f"class {name}{par} {{"]
        for f, v in zip(fields, init):
            lines.append(f"  {f}: number = {v};" if r.random() < 0.8 else f"  {f}: number;")
        ctor_args = s.classes[base]["ctor"] if base is not None else 0
        extra = r.randint(0, 1)
        ps = [f"a{j}" for j in range(ctor_args + extra)]
        sig = ", ".join(p + ": number" for p in ps)
        lines.append(f"  constructor({sig}) {{")
        if base is not None: lines.append(f"    super({', '.join(ps[:ctor_args])});")
        for f in fields:
            pass
        lines.append(f"    this.{fields[0]} = {ps[-1] if ps else '3'};")
        lines.append(f"    this.{fields[1]} = {r.choice(['7', '0.5', ps[0] if ps else '1'])};")
        lines.append("  }")
        reads = [f"@.{f}" for f in fields]; writes = [f"@.{f} = $" for f in fields] + [f"@.{f} += $" for f in fields]
        for j in range(r.randint(1, 3)):
            m = f"m{i}{j}"; p = "d"
            k = r.random()
            if k < 0.35:
                lines.append(f"  {m}({p}: number): number {{ this.{fields[0]} += {p}; return this.{fields[1]} {r.choice(['+','*','-'])} {p}; }}")
                reads.append(f"@.{m}($)"); writes.append(f"@.{m}($)")
            elif k < 0.7:
                lines.append(f"  {m}({p}: number): this {{ this.{fields[1]} = {p} {r.choice(['+','*'])} this.{fields[0]}; return this; }}")
                writes.append(f"@.{m}($)"); reads.append(f"@.{m}($).{fields[1]}")
            else:
                lines.append(f"  get {m}(): number {{ return this.{fields[0]} {r.choice(['+','-','%'])} this.{fields[1]}; }}")
                reads.append(f"@.{m}")
        if base is not None:
            reads += s.classes[base]["reads"]; writes += s.classes[base]["writes"]
        lines.append("}")
        s.classes.append(dict(name=name, ctor=len(ps), reads=reads, writes=writes))
        return "\n".join(lines)
    def function(s, i, fns):
        ps = [f"p{j}" for j in range(s.r.randint(1, 3))]
        e = dict(nums=list(ps), muts=list(ps), arrs=[], objs=[], insts=[], fns=list(fns))
        body = s.block(e, 3, False)
        env = {k: list(v) for k, v in e.items()}
        # the block's locals are its own: what is returned reads the parameters
        ret = s.expr(env, 3)
        return f"function f{i}({', '.join(p + ': number' for p in ps)}): number {{\n{body}\nreturn {ret};\n}}\n", (f"f{i}", len(ps))
    def program(s):
        out = []
        for i in range(s.r.randint(1, 3)): out.append(s.klass(i) + "\n")
        fns = []; sigs = []
        for i in range(s.r.randint(2, 5)):
            t, sig = s.function(i, fns)
            out.append(t); sigs.append(sig)
            if sig[1] == 1: fns.append(sig[0])
        for name, arity in sigs:
            for _ in range(s.r.choice([1, 1, 2])):
                args = ", ".join(s.const() for _ in range(arity))
                out.append(f"try {{ console.log(\"{name}\", 1, {name}({args})); }} catch (e: any) {{ console.log(\"{name}\", e.name); }}\n")
        return "".join(out)
if __name__ == "__main__":
    print(G(int(sys.argv[1])).program(), end="")
