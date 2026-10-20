#!/usr/bin/env python3
"""Moving-GC hazard checker for C sources (docs/gc_v2_design.md §6.6).

A young cell referenced by its address moves at a collection, and only the
slots the collector is given (frames, ts_gc_root slots, cell fields) are
rewritten. A value read into a temporary before a collection is stale after
it. The C compiler may evaluate a call's arguments in any order, so in

    out = ts_add(out, ts_string_slice_view(s, k, 1));

`out` may be read before the slice is allocated, and the collection that the
allocation triggers leaves the read copy pointing at the moved-from cell.

This checker reports such calls: one argument holds a heap value (type `tsv`
or a cell pointer, not a constant) while another argument may collect (it
calls, directly or through the call graph, an allocator, a collection, or an
unknown function through a pointer). It also reports reads of an unrooted
`tsv` or cell-pointer local after a call that may collect (a flow-sensitive
approximation: branches merge, loops run twice; a local whose address goes to
ts_gc_root is rooted). It works on clang's JSON AST and reports only; it is
not a gate (docs/gc_v2_design.md §6.6.1).

usage: gc_hazard_check.py [--cflags "..."] [--no-locals] file.c [file.c ...]
"""
import json, subprocess, sys, os, collections

SEEDS = {'gc_before_alloc', 'ts_gc_collect', 'ts_gc_collect_young'}
# Never produce a heap reference (numbers, booleans, keys): not stale-able.
NONHEAP_TSV = {'ts_num', 'ts_bool', 'ts_num_i', 'ts_int', 'ts_box_num', 'ts_box_bool'}
# Pointers to cells of the kinds a minor collection moves (promises,
# coroutines and proxies are allocated outside the nursery and never move).
CELL_TYPES = ('ts_object *', 'ts_array *', 'ts_string *', 'ts_func *', 'ts_map *',
              'ts_set_t *', 'ts_symbol *', 'ts_accessor *', 'ts_gc_header *',
              'struct ts_object *', 'struct ts_gc_header *', 'const ts_gc_header *',
              'const ts_object *', 'const ts_string *')

def ast(path, cflags):
    cmd = ['clang', '-Xclang', '-ast-dump=json', '-fsyntax-only'] + cflags + [path]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False).stdout
    return json.loads(out)

def strip(e):
    while e.get('kind') in ('ImplicitCastExpr', 'ParenExpr', 'CStyleCastExpr') and e.get('inner'):
        e = e['inner'][0]
    return e

def callee_name(call):
    c = strip(call['inner'][0]) if call.get('inner') else {}
    if c.get('kind') == 'DeclRefExpr':
        d = c.get('referencedDecl', {})
        if d.get('kind') == 'FunctionDecl':
            return d.get('name')
    return None   # an indirect call

def walk(n, f):
    f(n)
    for c in n.get('inner', ()) or ():
        if isinstance(c, dict): walk(c, f)


LOCALS = True

def tracked_type(t):
    return t == 'tsv' or t in CELL_TYPES

def check_locals(funcs, may, cur, track):
    """Unrooted `tsv` / cell-pointer locals read after a call that may collect
    (a flow-sensitive approximation: branches merge, loops run twice)."""
    out = {}
    for fname, fn in funcs.items():
        tracked = {}
        rooted = set()
        def collect(n):
            k = n.get('kind')
            if k in ('VarDecl', 'ParmVarDecl') and tracked_type((n.get('type') or {}).get('qualType', '')):
                if n.get('storageClass') not in ('static', 'extern'):
                    tracked[n['id']] = n.get('name', '?') + ' (' + (n.get('type') or {}).get('qualType', '') + ')'
            if k == 'CallExpr' and callee_name(n) in ('ts_gc_root', 'ts_root_static_once', 'gc_pin_value'):
                for a in (n.get('inner') or [])[1:]:
                    a = strip(a)
                    if a.get('kind') == 'UnaryOperator' and a.get('opcode') == '&':
                        d = strip(a['inner'][0])
                        if d.get('kind') == 'DeclRefExpr':
                            rooted.add(d['referencedDecl']['id'])
        walk(fn, collect)
        live = {i for i in tracked if i not in rooted}
        if not live:
            continue
        line = [0]
        loops = []      # stack of {'breaks': [], 'conts': []}
        def merge(*states):
            states = [x for x in states if x is not None]
            if not states: return None
            res = {}
            for v in live:
                vals = [x.get(v, 'N') for x in states]
                stale = [x for x in vals if isinstance(x, tuple)]
                res[v] = stale[0] if stale else ('F' if 'F' in vals else 'N')
            return res
        def note(n):
            track(n)
            line[0] = cur['line']
        def heapish(e):
            t = (e.get('type') or {}).get('qualType', '')
            if not tracked_type(t): return False
            s0 = strip(e)
            if s0.get('kind') in ('IntegerLiteral', 'CharacterLiteral'): return False
            if s0.get('kind') == 'CallExpr' and callee_name(s0) in NONHEAP_TSV: return False
            return True
        def ev(n, st):
            if st is None or not isinstance(n, dict) or not n: return st
            note(n)
            k = n.get('kind')
            inner = n.get('inner') or []
            if k == 'DeclRefExpr':
                d = n.get('referencedDecl') or {}
                v = d.get('id')
                if v in live:
                    x = st.get(v, 'N')
                    if isinstance(x, tuple):
                        key = (line[0], fname, tracked[v])
                        out.setdefault(key, x[1])
                return st
            if k == 'UnaryOperator' and n.get('opcode') == '&':
                d = strip(inner[0]) if inner else {}
                if d.get('kind') == 'DeclRefExpr' and (d.get('referencedDecl') or {}).get('id') in live:
                    return st          # address taken: not a read
                return ev(inner[0], st) if inner else st
            if k in ('BinaryOperator', 'CompoundAssignOperator'):
                op = n.get('opcode')
                lhs, rhs = inner[0], inner[1]
                ls = strip(lhs)
                if op == '=' and ls.get('kind') == 'DeclRefExpr' and (ls.get('referencedDecl') or {}).get('id') in live:
                    st = ev(rhs, st)
                    if st is None: return None
                    st = dict(st)
                    st[ls['referencedDecl']['id']] = 'F' if heapish(rhs) else 'N'
                    return st
                if op in ('&&', '||'):
                    a = ev(lhs, st)
                    return merge(a, ev(rhs, a))
                return ev(rhs, ev(lhs, st))
            if k == 'ConditionalOperator' or k == 'BinaryConditionalOperator':
                c = ev(inner[0], st)
                return merge(ev(inner[1], c), ev(inner[2], c) if len(inner) > 2 else c)
            if k == 'CallExpr':
                callee = callee_name(n)
                for a in inner[1:]:
                    st = ev(a, st)
                if inner and callee is None:
                    st = ev(inner[0], st)
                if st is None: return None
                st = dict(st)
                if callee is None or callee in may:
                    for v in live:
                        if st.get(v) == 'F': st[v] = ('S', line[0])
                # out parameters: &v passed to a call is written by the callee,
                # after any collection inside it
                for a in inner[1:]:
                    a2 = strip(a)
                    if a2.get('kind') == 'UnaryOperator' and a2.get('opcode') == '&':
                        d = strip(a2['inner'][0])
                        if d.get('kind') == 'DeclRefExpr' and (d.get('referencedDecl') or {}).get('id') in live:
                            st[d['referencedDecl']['id']] = 'F'
                return st
            if k == 'DeclStmt':
                for d in inner:
                    if d.get('kind') == 'VarDecl':
                        note(d)
                        init = (d.get('inner') or [None])[0]
                        if init: st = ev(init, st)
                        if st is None: return None
                        if d.get('id') in live:
                            st = dict(st); st[d['id']] = 'F' if (init and heapish(init)) else 'N'
                return st
            if k == 'CompoundStmt' or k == 'StmtExpr':
                for c in inner:
                    st = ev(c, st)
                return st
            if k == 'IfStmt':
                cond = inner[0]; then = inner[1] if len(inner) > 1 else None
                els = inner[2] if len(inner) > 2 else None
                c = ev(cond, st)
                return merge(ev(then, c) if then else c, ev(els, c) if els else c)
            if k in ('WhileStmt', 'ForStmt', 'DoStmt'):
                if k == 'WhileStmt': init, cond, inc, body = None, inner[0], None, inner[1]
                elif k == 'DoStmt': init, cond, inc, body = None, inner[1], None, inner[0]
                else:
                    parts = inner + [{}] * (5 - len(inner))
                    init, _cv, cond, inc, body = parts[:5]
                if init: st = ev(init, st)
                entry = st
                exits = []
                for _ in range(2):
                    loops.append({'breaks': [], 'conts': []})
                    if k == 'DoStmt':
                        sb = ev(body, entry)
                        sb = merge(sb, *loops[-1]['conts'])
                        sc = ev(cond, sb)
                        exits = [sc] + loops[-1]['breaks']
                        nxt = sc
                    else:
                        sc = ev(cond, entry) if cond else entry
                        sb = ev(body, sc)
                        sb = merge(sb, *loops[-1]['conts'])
                        if inc: sb = ev(inc, sb)
                        exits = [sc] + loops[-1]['breaks']
                        nxt = sb
                    loops.pop()
                    entry = merge(st, nxt)
                return merge(*exits)
            if k == 'SwitchStmt':
                c = ev(inner[0], st)
                loops.append({'breaks': [], 'conts': [], 'switch': c})
                body = inner[-1]
                s2 = c
                for stmt in (body.get('inner') or []) if body.get('kind') == 'CompoundStmt' else [body]:
                    s2 = ev(stmt, s2)
                ctx = loops.pop()
                if ctx['conts'] and loops: loops[-1]['conts'].extend(ctx['conts'])
                return merge(s2, c, *ctx['breaks'])
            if k in ('CaseStmt', 'DefaultStmt'):
                sw = next((l for l in reversed(loops) if 'switch' in l), None)
                st = merge(st, sw['switch'] if sw else None) if st is not None or sw else st
                for c in inner[1:] if k == 'CaseStmt' else inner:
                    st = ev(c, st)
                return st
            if k == 'ReturnStmt':
                for c in inner: st = ev(c, st)
                return None
            if k == 'BreakStmt':
                if loops: loops[-1]['breaks'].append(st)
                return None
            if k == 'ContinueStmt':
                lp = next((l for l in reversed(loops) if 'switch' not in l), None)
                if lp is not None: lp['conts'].append(st)
                return None
            if k == 'GotoStmt':
                return None
            if k == 'LabelStmt':
                # a goto target: assume any earlier state may arrive (approximation)
                return ev(inner[0], st if st is not None else {v: 'N' for v in live}) if inner else st
            for c in inner:
                st = ev(c, st)
            return st
        body = next((c for c in fn.get('inner', []) if c.get('kind') == 'CompoundStmt'), None)
        params = {c['id']: 'F' for c in fn.get('inner', []) if c.get('kind') == 'ParmVarDecl' and c.get('id') in live}
        st0 = {v: params.get(v, 'N') for v in live}
        ev(body, st0)
    return sorted((l, f, v, g) for (l, f, v), g in out.items())

def main():
    args = sys.argv[1:]
    cflags = []
    global LOCALS
    while args and args[0].startswith('--'):
        if args[0] == '--cflags':
            cflags = args[1].split(); args = args[2:]
        elif args[0] == '--no-locals':
            LOCALS = False; args = args[1:]
        else:
            raise SystemExit(f'unknown option {args[0]}')
    total = 0
    for path in args:
        root = ast(path, cflags)
        base = os.path.basename(path)
        # functions defined in this file, with their bodies; track file/line in order
        cur = {'file': None, 'line': 0}
        funcs = {}
        def track(n):
            for key in ('loc', ):
                l = n.get(key) or {}
                for src in (l, l.get('expansionLoc') or {}):
                    if 'file' in src: cur['file'] = src['file']
                    if 'line' in src: cur['line'] = src['line']
            r = (n.get('range') or {}).get('begin') or {}
            for src in (r, r.get('expansionLoc') or {}):
                if 'file' in src: cur['file'] = src['file']
                if 'line' in src: cur['line'] = src['line']
        lines_of = {}
        for top in root.get('inner', []):
            track(top)
            if top.get('kind') == 'FunctionDecl' and any(c.get('kind') == 'CompoundStmt' for c in top.get('inner', [])):
                if cur['file'] and os.path.basename(cur['file']) == base:
                    funcs[top['name']] = top
        # call graph
        calls = {}
        indirect = set()
        for name, fn in funcs.items():
            s = set()
            def visit(n):
                if n.get('kind') == 'CallExpr':
                    cn = callee_name(n)
                    if cn is None: indirect.add(name)
                    else: s.add(cn)
            walk(fn, visit)
            calls[name] = s
        may = set(SEEDS) | indirect
        changed = True
        while changed:
            changed = False
            for name, cs in calls.items():
                if name not in may and cs & may:
                    may.add(name); changed = True
        src_lines = open(path, errors='replace').read().split('\n')
        local_reports = check_locals(funcs, may, cur, track) if LOCALS else []
        for line, fname, var, gcline in local_reports:
            text = src_lines[line - 1].strip() if 0 < line <= len(src_lines) else ''
            print(f'{path}:{line}: {fname}: `{var}` is read after a call that may collect (line {gcline}) and is not rooted: {text[:140]}')
        total += len(local_reports)
        print(f'[gc-hazard] {path}: {len(local_reports)} stale local read(s)', file=sys.stderr)
        # report
        reports = []
        for name, fn in funcs.items():
            cur['line'] = 0
            def contains_gc(e):
                found = [False]
                def v(n):
                    if n.get('kind') == 'CallExpr':
                        cn = callee_name(n)
                        if cn is None or cn in may: found[0] = True
                walk(e, v)
                return found[0]
            def heapish(e):
                t = (e.get('type') or {}).get('qualType', '')
                if t != 'tsv' and t not in CELL_TYPES: return False
                s = strip(e)
                if s.get('kind') in ('IntegerLiteral', 'CharacterLiteral'): return False
                if s.get('kind') == 'CallExpr' and callee_name(s) in NONHEAP_TSV: return False
                if s.get('kind') == 'BinaryOperator' or s.get('kind') == 'UnaryOperator':
                    # TS_BOX(...) and other macro arithmetic on constants
                    lits = [False]
                    def v(n):
                        if n.get('kind') == 'DeclRefExpr' or n.get('kind') == 'CallExpr': lits[0] = True
                    walk(s, v)
                    if not lits[0]: return False
                return True
            def visit(n):
                track(n)
                if n.get('kind') != 'CallExpr': return
                inner = n.get('inner') or []
                a = inner[1:]
                if len(a) < 2: return
                gc_args = [i for i, x in enumerate(a) if contains_gc(x)]
                if not gc_args: return
                for i, x in enumerate(a):
                    if heapish(x) and any(j != i for j in gc_args):
                        reports.append((cur['line'], name, callee_name(n) or '(indirect)', i,
                                        [j for j in gc_args if j != i]))
                        break
            walk(fn, visit)
        reports.sort()
        seen = set()
        for line, fname, callee, i, gcs in reports:
            key = (line, callee, i)
            if key in seen: continue
            seen.add(key)
            text = src_lines[line - 1].strip() if 0 < line <= len(src_lines) else ''
            print(f'{path}:{line}: {fname}: {callee}() arg {i} holds a heap value while arg(s) {gcs} may collect: {text[:140]}')
        total += len(seen)
        print(f'[gc-hazard] {path}: {len(seen)} call(s); {len(may)} functions may collect', file=sys.stderr)
    return 1 if total else 0

if __name__ == '__main__':
    sys.exit(main())
