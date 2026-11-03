#!/usr/bin/env python3
# The fourth differential fuzzer: objects used as objects. Property order and delete, walks that change what they walk,
# descriptors, accessors, spread and rest, JSON round trips, prototype chains under a hot site, integrity levels, arrays and
# class instances with keys of their own, Proxies. Getters and traps write to a log, so the order of the operations is in the
# output as well as their results. Everything goes through `any` where the point is the dynamic path, and through types where
# the point is what a typed read makes of a dynamic write. A program is a dozen independent snippets.
import json, random, sys
NAMES = ["a", "b", "c", "d", "e", "f", "x", "y"]
INTS = ["0", "1", "2", "7", "10", "100"]
ODD = ["01", "-1", "1.5", "1e3", "4294967295", "4294967296", "", "a b", "constructor", "toString", "length", "valueOf"]
# the largest array index, in literals alone: on an array it makes a length that JSON.stringify walks to V8's string limit
ALL = NAMES + INTS + ODD + ["4294967294"]
VALS = ["0", "1", "-1", "2.5", "-0", "NaN", "Infinity", "1e21", "0.1", '"s"', '""', '"1"', "true", "false", "null", "undefined", "[1, 2]", "{ q: 1 }"]
JSON_LEAVES = ["0", "-0", "1", "1.5", "1e21", "1e-7", "123456789012345680000", "NaN", "Infinity", "true", "false", "null", "undefined", '""', '"a"', '"\\"q\\""', '"\\\\"', '"\\n\\t"', '"\\u2028"', '"é"', '"😀"', '"\\ud83d"',
               "new Date(0)", "new Date(NaN)", "new Number(3)", 'new String("s")', "new Boolean(false)", "new Map([[1, 2]])", "new Set([1])", "/x/g", "(() => 1)", 'Symbol("s")', "{ toJSON() { return 1; } }", "{ toJSON(k: string) { return k; } }", "[, 1]", "new Uint8Array(2)"]
JSON_TEXTS = ['{"a":1,"a":2}', '{"__proto__":1,"b":2}', '{"2":1,"b":2,"1":3}', '[1,[2,[3]]]', '1e400', '-0', '"\\ud83d"', '{"a":{"b":[{}]}}', ' [ ] ', '{"":1}', 'nul', '[1,]', '{"a"}', '01', '1.', '"\\x"', '"a\nb"', '{"a":1}x', '-', '[', '""', 'true', '1E2', '{"constructor":1,"toString":2}',
              '0x10', 'Infinity', 'NaN', 'inf', 'nan', '+1', '.5', '1e', '1e+', '-01', '-.5', '1.5e3', '"\\u00e9"', '"\\uD83D\\uDE00"', '\t1\n', '{"a":1,}', "'a'", '[1 2]', '{a:1}', '"\t"', '1.7976931348623157e308', '5e-324', '2.2250738585072011e-308', '9007199254740993', '123456789012345678901234567890']
class G:
    def __init__(s, seed):
        s.r = random.Random(seed); s.n = 0; s.decls = []
    def id(s, p="o"):
        s.n += 1; return f"{p}{s.n}"
    def val(s): return s.r.choice(VALS)
    def flag(s): return s.r.choice(["true", "false"])
    def rawkey(s, wide=False):
        c = s.r.random()
        if wide and c < 0.04: return "4294967294"
        return s.r.choice(NAMES) if c < 0.6 else s.r.choice(INTS) if c < 0.8 else s.r.choice(ODD)
    def key(s, k=None):
        # a key as an expression: a literal, a number, one the compiler cannot read
        k = k if k is not None else s.rawkey(); c = s.r.random()
        if c < 0.5: return json.dumps(k)
        if c < 0.75 and k in INTS: return k
        return f"K[{ALL.index(k)}]"
    def litkey(s, k):
        if k in NAMES: return k
        if k in INTS and s.r.random() < 0.5: return k
        return json.dumps(k)
    def literal(s, lo=0, hi=6, wide=True):
        seen = []; parts = []
        for _ in range(s.r.randint(lo, hi)):
            k = s.rawkey(wide)
            if k in seen: continue
            seen.append(k)
            parts.append(f"[K[{ALL.index(k)}]]: {s.val()}" if s.r.random() < 0.15 else f"{s.litkey(k)}: {s.val()}")
        return "{ " + ", ".join(parts) + " }" if parts else "{}"
    def cls(s):
        A = s.id("A"); B = s.id("B")
        s.decls.append(f"class {A} {{ a: any = {s.val()}; b: any = {s.val()}; c?: any; #p: any = 2; constructor(public d: any) {{}} get v(): any {{ return this.#p; }} set v(x: any) {{ this.#p = x; }} m(): number {{ return 2; }} static s = 1; }}")
        s.decls.append(f"class {B} extends {A} {{ e: any = {s.val()}; override m(): number {{ return super.m() + 1; }} }}")
        return A, B
    def base(s, o):
        # a declaration of `o`, any kind of object, with what it takes first
        c = s.r.randint(0, 8)
        if c <= 2: return [f"const {o}: any = {s.literal()};"]
        if c == 3: return [f"const {o}: any = Object.create({s.literal(0, 3)});"]
        if c == 4: return [f"const {o}: any = Object.create(null);"]
        if c == 5: return [f"const {o}: any = new ({s.cls()[1]})({s.val()});"]
        if c == 6: return [f"const {o}: any = function () {{ return 1; }};"]
        if c == 7: return [f"const {o}: any = [1, 2, 3];"]
        n = s.r.choice([5, 9, 17, 33, 65, 130])
        return [f"const {o}: any = {{}};", f"for (let i = 0; i < {n}; i++) {o}[\"k\" + i] = i;", f"for (let i = 0; i < {n}; i += 3) delete {o}[\"k\" + i];"]
    def op(s, o, l):
        r = s.r; k = s.key(); v = s.val(); c = r.random()
        if c < 0.30: x = f"{o}[{k}] = {v};"
        elif c < 0.38: x = f"{o}.{r.choice(NAMES)} = {v};"
        elif c < 0.58: x = f"delete {o}[{k}];"
        elif c < 0.66: x = f"delete {o}.{r.choice(NAMES)};"
        elif c < 0.76: x = f"Object.defineProperty({o}, {k}, {{ value: {v}, enumerable: {s.flag()}, writable: {s.flag()}, configurable: {s.flag()} }});"
        elif c < 0.84: x = f"Object.defineProperty({o}, {k}, {{ get() {{ {l}.push(\"g\"); return {v}; }}, set(q: any) {{ {l}.push(\"s\"); }}, enumerable: {s.flag()}, configurable: {s.flag()} }});"
        elif c < 0.88: x = f"Object.defineProperty({o}, {k}, {{ enumerable: {s.flag()} }});"
        elif c < 0.92: x = f"Object.assign({o}, {s.literal(0, 3, False)});"
        elif c < 0.95: x = f"Object.setPrototypeOf({o}, {s.literal(0, 2)});"
        elif c < 0.97: x = f"Object.{r.choice(['freeze', 'seal', 'preventExtensions'])}({o});"
        else: x = f"p({o}[{k}], {k} in {o}, Object.hasOwn({o}, {k}));"
        return f"try {{ {x} }} catch (e: any) {{ p(\"threw\", e.name); }}"
    def snap(s, o):
        return [f"p(Object.keys({o}), Object.getOwnPropertyNames({o}), Reflect.ownKeys({o}).length);", f"const ks{o}: string[] = []; for (const k in {o}) ks{o}.push(k); p(ks{o});",
                f"p(Object.values({o}), Object.entries({o}).length, JSON.stringify({o}), {{ ...{o} }}, Object.assign({{}}, {o}));"]
    def churn(s):
        r = s.r; o = s.id(); l = s.id("l")
        out = s.base(o) + [f"const {l}: string[] = [];"]
        for i in range(r.randint(1, 3)):
            out += [s.op(o, l) for _ in range(r.randint(2, 6))]
            out += [f"p(Object.keys({o}), {l}.splice(0));"]
        return out + s.snap(o) + [f"p({l});"]
    def forin(s):
        # keys go and come during the walk, on the object and on its chain
        r = s.r; o = s.id(); q = s.id("q"); l = s.id("l")
        acts = [f"delete {o}[{s.key()}];", f"delete {q}[{s.key()}];", f"{o}[{s.key()}] = 1;", f"{q}[{s.key()}] = 1;", f"Object.defineProperty({o}, {s.key()}, {{ enumerable: false }});", f"Object.defineProperty({q}, {s.key()}, {{ enumerable: false, value: 1 }});", f"Object.setPrototypeOf({o}, {{ z: 1 }});", f"Object.keys({o}).forEach((k: string) => delete {o}[k]);"]
        return [f"const {q}: any = {s.literal(0, 3)};", f"const {o}: any = Object.setPrototypeOf({s.literal(1, 6)}, {q});", f"const {l}: string[] = [];",
                f"let {l}n = 0; for (const k in {o}) {{ {l}.push(k); if ({l}n++ === {r.randint(0, 3)}) {{ {r.choice(acts)} }} if ({l}n > 40) break; }}", f"p({l}, Object.keys({o}));"]
    def accessors(s):
        # a fresh object for each consumer: the order of the getters is the point, and one of them may delete a later key
        r = s.r; l = s.id("l"); mk = s.id("mk"); names = r.sample(NAMES, 5); parts = []
        for n in names:
            c = r.random()
            if c < 0.4: parts.append(f"get {n}() {{ {l}.push(\"get {n}\"); return {s.val()}; }}")
            elif c < 0.55: parts.append(f"get {n}() {{ {l}.push(\"del\"); delete o[{json.dumps(r.choice(names))}]; o.z = 1; return {s.val()}; }}")
            elif c < 0.7: parts.append(f"set {n}(q: any) {{ {l}.push(\"set {n}\"); }}")
            else: parts.append(f"{n}: {s.val()}")
        out = [f"const {l}: string[] = [];", f"const {mk} = (): any => {{ const o: any = {{ {', '.join(parts)} }}; return o; }};"]
        t = s.id("t"); a = names[0]; q = s.id("q")
        for e in [f"{{ ...{mk}() }}", f"Object.assign({{ x: 0 }}, {mk}())", f"Object.entries({mk}())", f"Object.values({mk}())", f"Object.keys({mk}())", f"JSON.stringify({mk}())", f"Object.getOwnPropertyDescriptors({mk}())", f"Object.assign({t}, {mk}())", f"Object.fromEntries(Object.entries({mk}()))"]:
            out.append(f"try {{ p({e}, {l}.splice(0)); }} catch (e: any) {{ p(\"threw\", e.name, {l}.splice(0)); }}") if t not in e else out.extend([f"const {t}: any = {{ set {a}(q: any) {{ {l}.push(\"target\"); }} }};", f"try {{ p({e}, {l}.splice(0)); }} catch (e: any) {{ p(\"threw\", e.name, {l}.splice(0)); }}"])
        return out + [f"const {{ {a}: {q}, ...{q}r }} = {mk}(); p({q}, {q}r, {l}.splice(0));"]
    def spreads(s):
        r = s.r; a = s.id("a"); b = s.id("b"); c = s.id("c"); q = s.id("q"); n = s.id("n")
        return [f"const {a}: any = {s.literal()};", f"const {b}: any = {s.literal()};", f"const {c}: any = {{ ...{a}, [K[{ALL.index(s.rawkey())}]]: {s.val()}, ...{b}, x: {s.val()} }};",
                f"const {{ x: {q}, [{s.key()}]: {q}w = 9, ...{q}r }} = {c};", f"p({c}, {q}, {q}w, {q}r);", f"const {n}: any[] = [null, undefined, 1, \"ab\", [1, 2], true, new Map([[1, 2]]), () => 1];", f"p({n}.map((v: any) => ({{ ...v }})));",
                f"const {q}t = {{ x: {r.randint(0, 9)}, y: \"s\" }}; const {q}u = {{ y: {r.randint(0, 9)}, z: [1] }}; const {q}v = {{ ...{q}t, ...{q}u, w: 3 }}; p({q}v.x + {q}v.y + {q}v.z.length, {q}v, {{ ...{q}v, ...({r.randint(0, 1)} > 0 && {{ k: 1 }}) }});"]
    def jv(s, d=3):
        r = s.r; c = r.random()
        if d <= 0 or c < 0.35: return r.choice(JSON_LEAVES)
        if c < 0.65: return "[" + ", ".join(s.jv(d - 1) for _ in range(r.randint(0, 4))) + "]"
        keys = r.sample(NAMES + INTS, r.randint(0, 4))
        return "{ " + ", ".join(f"{s.litkey(k)}: {s.jv(d - 1)}" for k in keys) + " }"
    def jsons(s):
        r = s.r; v = s.id("v"); t = s.id("t"); tx = s.id("s")
        return [f"const {v}: any = {s.jv()};", f"const {t} = JSON.stringify({v});", f"p({t}, JSON.stringify({v}, null, 2), JSON.stringify({v}, null, \"--\"), JSON.stringify({v}, [\"a\", \"0\"]), JSON.stringify({v}, (k: string, x: any) => typeof x === \"number\" ? x + 1 : x));",
                f"try {{ p(JSON.parse({t}), JSON.parse({t}, (k: string, x: any) => Array.isArray(x) ? x.length : x)); }} catch (e: any) {{ p(\"threw\", e.name); }}",
                f"try {{ p(structuredClone({v})); }} catch (e: any) {{ p(\"threw\", e.name); }}", f"const {tx}: string = {json.dumps(r.choice(JSON_TEXTS))};",
                f"try {{ const j = JSON.parse({tx}); p(j, Object.keys(Object(j)), JSON.stringify(j)); }} catch (e: any) {{ p(\"threw\", e.name); }}"]
    def protos(s):
        # one read site, one write site and one call site kept hot while the chain under them changes
        r = s.r; b = s.id("b"); m = s.id("m"); o = s.id(); rd = s.id("rd"); wr = s.id("wr"); ca = s.id("ca"); l = s.id("l"); k = r.choice(NAMES); j = json.dumps(k)
        out = [f"const {b}: any = {{ {k}: {s.val()}, m() {{ return 1; }} }};", f"const {m}: any = Object.create({b});", f"const {o}: any = Object.create({m});", f"const {l}: any[] = [];",
               f"const {rd} = (q: any) => q.{k};", f"const {wr} = (q: any, v: any) => {{ try {{ q.{k} = v; }} catch (e: any) {{ {l}.push(e.name); }} }};", f"const {ca} = (q: any) => {{ try {{ return q.m(); }} catch (e: any) {{ return e.name; }} }};"]
        for _ in range(r.randint(2, 6)):
            v = s.val()
            act = r.choice([f"{o}.{k} = {v};", f"delete {o}.{k};", f"{m}.{k} = {v};", f"delete {m}.{k};", f"{b}.{k} = {v};", f"delete {b}.{k};", f"Object.setPrototypeOf({m}, {{ {k}: {v}, m() {{ return 2; }} }});", f"Object.setPrototypeOf({o}, {b});", f"Object.setPrototypeOf({o}, {m});", f"Object.setPrototypeOf({o}, null);",
                            f"Object.defineProperty({m}, {j}, {{ get() {{ return 5; }}, set(q: any) {{ {l}.push(\"set\"); }}, configurable: true }});", f"Object.defineProperty({b}, {j}, {{ value: 7, writable: false, configurable: true }});", f"Object.defineProperty({m}, {j}, {{ get() {{ return 6; }}, configurable: true }});",
                            f"Object.freeze({b});", f"Object.freeze({o});", f"{m}.m = () => 3;", f"delete {b}.m;", f"{o}.m = () => 4;", f"delete {o}.m;"])
            out += [f"for (let i = 0; i < 3; i++) {{ {l}.push({rd}({o}), {ca}({o})); }}", f"try {{ {act} }} catch (e: any) {{ {l}.push(e.name); }}", f"{wr}({o}, {r.randint(0, 9)});"]
        return out + [f"p({l}, Object.keys({o}), {rd}({o}), {rd}({m}), {rd}({b}), {j} in {o}, Object.hasOwn({o}, {j}));"]
    def integrity(s):
        r = s.r; o = s.id(); l = s.id("l"); lvl = r.choice(["freeze", "seal", "preventExtensions"])
        base = r.choice([f"{s.literal(1, 4)}", "[1, 2, 3]", f"new ({s.cls()[1]})(1)", "Object.create({ h: 1 })", "function () { return 1; }"])
        ops = [f"{o}[{s.key()}] = 1;", f"{o}.a = 2;", f"delete {o}[{s.key()}];", f"delete {o}.a;", f"Object.defineProperty({o}, {s.key()}, {{ value: 3 }});", f"Object.setPrototypeOf({o}, {{}});", f"{o}.push?.(1);", f"{o}.pop?.();", f"{o}.length = 0;", f"Object.assign({o}, {{ a: 1 }});"]
        return [f"const {o}: any = {base};", f"const {l} = Object.{lvl}({o}) === {o};"] + [f"try {{ {x} p(\"ok\"); }} catch (e: any) {{ p(\"threw\", e.name); }}" for x in r.sample(ops, 5)] + \
               [f"p({l}, Object.isFrozen({o}), Object.isSealed({o}), Object.isExtensible({o}), Object.keys({o}), Object.getOwnPropertyDescriptor({o}, \"a\"));"]
    def arrays(s):
        # keys of their own, holes, a length that moves, and what the methods make of them
        r = s.r; a = s.id("a"); l = s.id("l")
        def i(): return r.choice(["0", "1", "2", "5", "9"])
        ops = [f"{a}.foo = {s.val()};", f"delete {a}[{i()}];", f"{a}[{i()}] = {s.val()};", f"{a}.length = {r.choice(['0', '1', '4', '12'])};", f"{a}[\"{i()}\"] = {s.val()};", f"{a}[\"-1\"] = 1;", f"{a}[\"1.5\"] = 1;", f"{a}[\"01\"] = 1;",
               f"Object.defineProperty({a}, {i()}, {{ value: 7, enumerable: {s.flag()}, writable: {s.flag()}, configurable: true }});", f"Object.defineProperty({a}, {i()}, {{ get() {{ {l}.push(\"g\"); return 8; }}, enumerable: true, configurable: true }});",
               f"{a}.push({s.val()});", f"{a}.pop();", f"{a}.shift();", f"{a}.unshift({s.val()});", f"{a}.splice({r.randint(0, 3)}, {r.randint(0, 2)}, {s.val()});", f"{a}.reverse();", f"{a}.fill({s.val()}, {r.randint(0, 3)});", f"{a}.copyWithin(0, 1);",
               f"{a}.sort();", f"delete {a}.length;", f"Object.setPrototypeOf({a}, {{ 3: \"p\", length: 99 }});"]
        out = [f"const {a}: any = {r.choice(['[1, 2, 3]', '[]', '[1, , 3]', '[\"a\", \"b\", \"c\", \"d\"]', 'new Array(4)', '[1.5, 2.5]', '[null, undefined, {}]'])};", f"const {l}: string[] = [];"]
        out += [f"try {{ {x} }} catch (e: any) {{ p(\"threw\", e.name); }}" for x in r.sample(ops, r.randint(2, 6))]
        return out + [f"const ks{a}: string[] = []; for (const k in {a}) ks{a}.push(k);", f"try {{ p({a}, {a}.length, Object.keys({a}), ks{a}, JSON.stringify({a}), [...{a}], {a}.map((x: any) => x), {a}.filter(() => true), {a}.indexOf(undefined), {a}.includes(undefined), {a}.join(), {l}); }} catch (e: any) {{ p(\"threw\", e.name); }}"]
    def instances(s):
        # a class's fields changed through `any` and read through the class
        r = s.r; o = s.id(); A, B = s.cls(); l = s.id("l"); c = s.id("c")
        out = [f"const {o}: any = new {B}({s.val()});", f"const {l}: string[] = [];"]
        out += [s.op(o, l) for _ in range(r.randint(1, 4))]
        return out + [f"const {c} = {o} as {B};", f"try {{ p({c}.a, {c}.b, {c}.c, {c}.d, {c}.e, {c}.v, Object.keys({c}), JSON.stringify({c}), {{ ...{c} }}, {c} instanceof {A}, {c}.hasOwnProperty(\"a\"), \"v\" in {c}, {c}.m()); }} catch (e: any) {{ p(\"threw\", e.name); }}", f"p({l});"]
    def proxies(s):
        # every trap logs and forwards: the sequence of traps a consumer makes is the output
        r = s.r; o = s.id(); l = s.id("l"); h = s.id("h")
        ops = [f"{{ ...{o} }}", f"Object.keys({o})", f"Object.entries({o})", f"JSON.stringify({o})", f"Object.assign({{}}, {o})", f"Object.getOwnPropertyDescriptors({o})", f"{s.key()} in {o}", f"Object.hasOwn({o}, {s.key()})", f"{o}[{s.key()}]",
               f"({o}[{s.key()}] = {s.val()})", f"delete {o}[{s.key()}]", f"Object.defineProperty({o}, {s.key()}, {{ value: 1, configurable: true }})", f"Object.isFrozen({o})", f"Object.getPrototypeOf({o})", f"Reflect.ownKeys({o})", f"Object.freeze({o})"]
        out = [f"const {l}: string[] = [];", f"const {h}: any = {{ get(t: any, k: any, r: any) {{ {l}.push(\"get \" + String(k)); return Reflect.get(t, k, r); }}, set(t: any, k: any, v: any, r: any) {{ {l}.push(\"set \" + String(k)); return Reflect.set(t, k, v, r); }}, has(t: any, k: any) {{ {l}.push(\"has \" + String(k)); return Reflect.has(t, k); }}, deleteProperty(t: any, k: any) {{ {l}.push(\"delete \" + String(k)); return Reflect.deleteProperty(t, k); }}, ownKeys(t: any) {{ {l}.push(\"ownKeys\"); return Reflect.ownKeys(t); }}, getOwnPropertyDescriptor(t: any, k: any) {{ {l}.push(\"gopd \" + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); }}, defineProperty(t: any, k: any, d: any) {{ {l}.push(\"define \" + String(k)); return Reflect.defineProperty(t, k, d); }}, getPrototypeOf(t: any) {{ {l}.push(\"getProto\"); return Reflect.getPrototypeOf(t); }}, preventExtensions(t: any) {{ {l}.push(\"prevent\"); return Reflect.preventExtensions(t); }}, isExtensible(t: any) {{ {l}.push(\"isExtensible\"); return Reflect.isExtensible(t); }} }};",
               f"const {o}: any = new Proxy({s.literal(1, 5)}, {h});"]
        out += [f"try {{ p({x}, {l}.join(\",\")); }} catch (e: any) {{ p(\"threw\", e.name, {l}.join(\",\")); }} {l}.length = 0;" for x in r.sample(ops, r.randint(3, 7))]
        return out
    def symbols(s):
        r = s.r; o = s.id(); y = s.id("y"); z = s.id("z")
        return [f"const {y} = Symbol(\"y\");", f"const {z} = Symbol.for(\"z\");", f"const {o}: any = {{ b: 1, [{y}]: 2, 1: 3, [{z}]: 4, a: 5 }};", f"{o}[Symbol.toStringTag] = {r.choice(['\"T\"', '1'])};", f"delete {o}[{r.choice([y, z])}];",
                f"p({o}, Object.keys({o}), Object.getOwnPropertySymbols({o}).length, Reflect.ownKeys({o}).map(String), JSON.stringify({o}), {{ ...{o} }}, Object.assign({{}}, {o}), Object.prototype.toString.call({o}), {r.choice([y, z])} in {o});"]
    def tables(s):
        r = s.r; e = s.id("e"); m = s.id("m"); v = s.id("v")
        pairs = ", ".join(f"[{json.dumps(s.rawkey())}, {s.val()}]" for _ in range(r.randint(0, 6)))
        return [f"const {e}: [string, any][] = [{pairs}];", f"const {m} = new Map<string, any>({e});", f"const {v}: any = Object.fromEntries({e});", f"p({v}, Object.fromEntries({m}), Object.entries({v}).length, {m}.size, Object.keys({v}), new Map(Object.entries({v})).size);",
                f"p(Object.groupBy({e}, ([k, q]: [string, any]) => typeof q), Map.groupBy({e}, ([k, q]: [string, any]) => k.length).size);"]
    def program(s):
        kinds = [s.churn, s.churn, s.forin, s.accessors, s.spreads, s.jsons, s.protos, s.protos, s.integrity, s.arrays, s.instances, s.proxies, s.symbols, s.tables]
        body = []
        for i in range(s.r.randint(8, 14)):
            kind = s.r.choice(kinds)
            body.append("{\n" + f'p("-- {kind.__name__} {i}");\n' + "\n".join(kind()) + "\n}")  # the marker: a diff names its snippet
        head = f"// @ts-nocheck\nconst p = (...a: unknown[]) => console.log(...a);\nconst K: any[] = {json.dumps(ALL)};\n"  # the checker's lib is ES2020: Object.hasOwn, Object.groupBy
        return head + "\n".join(s.decls) + "\n" + "\n".join(body) + "\n"
if __name__ == "__main__":
    print(G(int(sys.argv[1])).program(), end="")
