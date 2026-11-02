#!/usr/bin/env python3
# The third differential fuzzer: small independent snippets over the language's features, each with its own locals and a
# printed result, where lowering and representation choices meet: strings and numbers, collections, patterns, coroutines,
# captures in loops, classes with inheritance, typed arrays, nullable values. A program is a dozen of them.
import random, sys
N = ["0","1","2","3","5","7","10","100","-1","-3","0.5","1.5","255","256","65536","2147483647","-2147483648"]
S = ['""','"a"','"abc"','"hello world"','"é"','"😀x"','"12"','"-3.5"','" 7 "']
class G:
    def __init__(s, seed):
        s.r = random.Random(seed); s.n = 0; s.decls = []
    def id(s, p="x"):
        s.n += 1; return f"{p}{s.n}"
    def num(s): return s.r.choice(N)
    def str(s): return s.r.choice(S)
    def nexpr(s, vs, d=2):
        r = s.r
        if d <= 0 or r.random() < 0.35:
            return r.choice(vs) if vs and r.random() < 0.7 else s.num()
        a, b = s.nexpr(vs, d-1), s.nexpr(vs, d-1)
        return r.choice([f"({a} + {b})", f"({a} - {b})", f"({a} * {b})", f"({a} / {b})", f"({a} % {b})", f"({a} | {b})", f"({a} & {b})", f"({a} >> {b})", f"({a} >>> 0)", f"Math.floor({a})", f"(-({a}))"])
    def sexpr(s, vs, sv, d=2):
        r = s.r
        if d <= 0 or r.random() < 0.3:
            return r.choice(sv) if sv and r.random() < 0.7 else s.str()
        a, b, n = s.sexpr(vs, sv, d-1), s.sexpr(vs, sv, d-1), s.nexpr(vs, 1)
        return r.choice([f"({a} + {b})", f"({a} + {n})", f"({n} + {a})", f"`${{{a}}}-${{{n}}}`", f"{a}.slice({n})", f"{a}.substring({n})", f"{a}.toUpperCase()", f"{a}.trim()", f"{a}.padStart(4, \"*\")", f"{a}.repeat(2)", f"String({n})", f"({n}).toString()", f"{a}.replace(\"a\", {b})", f"{a}.split(\"\").reverse().join(\"\")", f"{a}.charAt(1)", f"[{a}, {b}].join(String({n}))"])
    def strings(s):
        r = s.r; v = s.id("v"); w = s.id("w"); n = s.num(); a = s.sexpr([v], [w]); 
        return [f"let {v} = {n};", f"let {w} = {s.str()};", f"{w} += {s.sexpr([v],[w])};", f"for (let i = 0; i < 3; i++) {{ {w} = {a}.slice(0, 40); {v} += {w}.length; }}",
                f"p({w}, {w}.length, {v}, {w}.charCodeAt(0), {w}.indexOf(\"a\"), {w} < {s.str()}, {w}.charAt({w}.length - 1), parseInt({w}), Number({w}), {w}.includes(\"l\"));"]
    def maps(s):
        r = s.r; m = s.id("m"); t = s.id("t"); k = s.id("k")
        keys = [s.num() for _ in range(4)] + ["NaN", "-0"]
        return [f"const {m} = new Map<number, number>();", f"const {t} = new Set<number>();",
                *[f"{m}.set({x}, {s.num()}); {t}.add({x});" for x in keys], f"{m}.delete({s.num()}); {t}.delete({s.num()});",
                f"let {k} = 0; for (const [a, b] of {m}) {k} += (a | 0) + (b | 0); for (const a of {t}) {k} ^= a | 0;",
                f"{m}.forEach((v, q) => {{ if (q === {s.num()}) {m}.delete(q); }});",
                f"p({k}, {m}.size, {t}.size, [...{m}.keys()], [...{t}], {m}.get({s.num()}) ?? -1, {t}.has({s.num()}));"]
    def patterns(s):
        r = s.r; f = s.id("f"); a = s.num(); b = s.num()
        s.decls.append(f"function {f}({{ a, b = {s.num()} }}: {{ a: number; b?: number }}, [c, d = {s.num()}, ...e]: number[], g: number = a + 1, ...h: number[]): number[] {{ return [a, b, c, d, e.length, g, h.length]; }}")
        o = s.id("o"); q = s.id("q")
        return [f"const {o} = {{ a: {a}, b: {b}, n: {{ c: {s.num()} }} }};", f"const {{ a: {q}a, n: {{ c: {q}c }}, ...{q}r }} = {o};", f"const [{q}x, , {q}y = {s.num()}, ...{q}z] = [{s.num()}, {s.num()}, undefined, {s.num()}];",
                f"p({q}a, {q}c, {q}r, {q}x, {q}y, {q}z, {f}({{ a: {s.num()} }}, [{s.num()}]), {f}({{ a: {s.num()}, b: {s.num()} }}, [{s.num()}, {s.num()}, {s.num()}], {s.num()}, {s.num()}, {s.num()}));"]
    def coroutines(s):
        r = s.r; g = s.id("g"); h = s.id("h")
        s.decls.append(f"function* {g}(n: number): Generator<number, number, any> {{ let t: number = {s.num()}; for (let i = 0; i < n; i++) {{ try {{ const v: number = yield t + i; t = (t * 3 + (v ?? 0)) | 0; if (i === {r.randint(0,3)}) throw new Error(\"g\"); }} catch {{ t += 1; }} finally {{ t ^= 5; }} }} return t; }}")
        s.decls.append(f"async function {h}(n: number): Promise<number> {{ let t = {s.num()}; for (let i = 0; i < n; i++) {{ try {{ t += await Promise.resolve(i * 2.5); if (i === {r.randint(0,3)}) await Promise.reject(new Error(\"h\")); }} catch {{ t = t / 2; }} finally {{ t += 0.25; }} }} return t; }}")
        it = s.id("it")
        return [f"const {it} = {g}({r.randint(1,4)});", f"const {it}a: unknown[] = []; for (let r = {it}.next(0); !r.done; r = {it}.next({s.num()})) {{ {it}a.push(r.value); if ({it}a.length > 9) break; }}",
                f"p({it}a, [...{g}({r.randint(0,3)})]);", f"{h}({r.randint(0,4)}).then((v) => p(\"async\", v));"]
    def captures(s):
        r = s.r; a = s.id("fs"); 
        return [f"const {a}: (() => number)[] = [];", f"for (let i = 0; i < 3; i++) {{ let j = i * {s.num()}; {a}.push(() => i + j++); if (i === 1) i += 0; }}",
                f"var {a}v = 0; for (var q{a} = 0; q{a} < 3; q{a}++) {{ {a}.push(() => q{a} + {a}v); }}", f"for (const k of [1, 2]) {{ {a}.push(() => k * {s.num()}); }}", f"for (const k in {{ a: 1, b: 2 }}) {{ {a}.push(() => k.length); }}",
                f"let {a}w = 0; while ({a}w < 2) {{ const c = {a}w; {a}.push(() => c + 0.5); {a}w++; }}", f"p({a}.map((f) => f()), {a}.map((f) => f()));"]
    def classes(s):
        r = s.r; A = s.id("A"); B = s.id("B"); C = s.id("C")
        s.decls.append(f"class {A} {{ static count = {s.num()}; x: number; #p = {s.num()}; constructor(x: number) {{ this.x = x; {A}.count++; }} get v(): number {{ return this.x + this.#p; }} set v(n: number) {{ this.#p = n - this.x; }} m(a: number): number {{ return this.x * a; }} static make(x: number) {{ return new this(x); }} toString() {{ return `A(${{this.x}})`; }} }}")
        s.decls.append(f"class {B} extends {A} {{ y = {s.num()}; constructor(x: number) {{ super(x + 1); this.y += x; }} override m(a: number): number {{ return super.m(a) + this.y; }} override get v(): number {{ return super.v + 1; }} override set v(n: number) {{ super.v = n * 2; }} }}")
        s.decls.append(f"class {C} extends {B} {{ override m(a: number): number {{ return -super.m(a); }} }}")
        o = s.id("o"); l = s.id("l")
        return [f"const {l}: {A}[] = [new {A}({s.num()}), new {B}({s.num()}), new {C}({s.num()}), {B}.make({s.num()})];", f"let {o} = 0; for (const e of {l}) {{ {o} += e.m({s.num()}); e.v = {s.num()}; {o} += e.v; }}",
                f"p({o}, {A}.count, {l}.map((e) => `${{e}}`), {l}.map((e) => e instanceof {B}), {l}[1] instanceof {C}, Object.keys({l}[1]), JSON.stringify({l}[2]));"]
    def typed(s):
        r = s.r; K = r.choice(["Int8Array","Uint8Array","Uint8ClampedArray","Int16Array","Uint16Array","Int32Array","Uint32Array","Float32Array","Float64Array"]); t = s.id("t")
        return [f"const {t} = new {K}({r.randint(1,6)});", f"for (let i = 0; i < {t}.length + 1; i++) {t}[i] = {s.nexpr(['i'], 2)};", f"{t}.fill({s.num()}, 1, 2);", f"{t}.reverse();",
                f"let {t}s = 0; for (const e of {t}) {t}s += e; for (let i = 0; i < {t}.length; i++) {t}s -= {t}[i] / 2;", f"p({t}, {t}s, {t}[{t}.length], {t}.slice(1), {t}.subarray(1).length, {t}.indexOf({s.num()}), Array.from({t}).length);"]
    def nullable(s):
        r = s.r; f = s.id("n"); o = s.id("o")
        s.decls.append(f"function {f}(a: number | undefined, b?: number, c: number | null = null): number {{ const d = a ?? {s.num()}; const e = b === undefined ? d : b + d; return (c ?? e) + (c === null ? 1 : 0); }}")
        s.decls.append(f"interface {o}T {{ q?: {{ r?: number; s: number[] }}; t: number | string }}")
        return [f"const {o}a: {o}T = {{ q: {{ s: [{s.num()}] }}, t: {r.choice([s.num(), s.str()])} }};", f"const {o}b: {o}T = {{ t: {s.num()} }};",
                f"p({f}(undefined), {f}({s.num()}), {f}({s.num()}, {s.num()}), {f}(undefined, {s.num()}, {s.num()}), {o}a.q?.r ?? -1, {o}b.q?.s[0] ?? -2, {o}a.q?.s.length, {o}b.q?.r, typeof {o}a.t, typeof {o}b.t, {o}a.t === {o}b.t);"]
    def controls(s):
        r = s.r; v = s.id("v")
        return [f"let {v} = 0;", f"outer: for (let i = 0; i < 4; i++) {{ for (let j = 0; j < 4; j++) {{ if (j === {r.randint(0,3)}) continue outer; if (i === {r.randint(1,3)}) break outer; {v} += i * j + 1; }} }}",
                f"let {v}n = 0; do {{ {v} = ({v} * 2 + 1) % 17; }} while ({v} % {r.choice([3,5,7])} !== 0 && {v} < 50 && ++{v}n < 20);", f"switch ({v} % 4) {{ case 0: {v} += 1; case 1: {v} += 2; break; case 2: {{ {v} += 3; break; }} default: {v} -= 1; }}",
                f"const {v}f = (a: number): number => {{ try {{ if (a > {s.num()}) return a; throw a; }} catch (e) {{ return (e as number) + 1; }} finally {{ {v} += 1; }} }};", f"p({v}, {v}f({s.num()}), {v}f({s.num()}), {v});"]
    def program(s):
        kinds = [s.strings, s.maps, s.patterns, s.coroutines, s.captures, s.classes, s.typed, s.nullable, s.controls]
        body = []
        for _ in range(s.r.randint(6, 12)):
            body.append("{\n" + "\n".join(s.r.choice(kinds)()) + "\n}")
        head = "const p = (...a: unknown[]) => console.log(...a);\n"
        return head + "\n".join(s.decls) + "\n" + "\n".join(body) + "\n"
if __name__ == "__main__":
    print(G(int(sys.argv[1])).program(), end="")
