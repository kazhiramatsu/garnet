#!/usr/bin/env python3
"""prof_pc.py <pc file> <binary> <units dir> [top]: the profile a TSAOT_PROF_PC run wrote, by symbol, by C
line and by machine-instruction class (docs/agent_workflow.md, "Profiling a native build").

The binary must carry line tables and keep its symbols: a unit build with TSAOT_UNITS_LTO=0 and
TSAOT_NATIVE_CC='cc -O2 -gline-tables-only -fno-omit-frame-pointer' (ThinLTO leaves the line tables in
temporary objects atos cannot find). <units dir> holds the generated C the lines refer to; the runtime's
lines resolve against runtime/ and the tsc-ts host's against benchmarks/tsc_ts_native/."""
import re, sys, subprocess, collections, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pcf, binary, units = sys.argv[1], sys.argv[2], sys.argv[3]
top = int(sys.argv[4]) if len(sys.argv) > 4 else 50
lines = open(pcf).read().split('\n')
slide = int(lines[0].split()[1], 16)
cnt = collections.Counter()          # samples by PC (file address) for PCs in this image
outside = collections.Counter()      # samples outside the image: (image, symbol) -> count
outside_callers = collections.Counter()   # ... attributed to the nearest return address inside the image
for l in lines[2:]:
    if not l.strip(): continue
    parts = l.split(); a = int(parts[0], 16) - slide; c = int(parts[1])
    img = parts[2] if len(parts) > 2 else 'tsc-ts'
    if img == 'tsc-ts' or not img:
        cnt[a] += c; continue
    sym = parts[3].split('+')[0] if len(parts) > 3 else '?'
    outside[(img, sym)] += c
    for ra in parts[4:6]:
        r = int(ra, 16) - slide
        if 0x100000000 <= r < 0x180000000:
            outside_callers[(r, sym)] += c; break
    else:
        outside_callers[(0, sym)] += c
total = sum(cnt.values()) + sum(outside.values())
# symbol + line by atos (file addresses with -l 0x100000000 convention: atos takes load address)
addrs = [hex(a) for a in cnt]
res = {}
for i in range(0, len(addrs), 500):
    chunk = addrs[i:i + 500]
    out = subprocess.run(['atos', '-o', binary, '-l', '0x100000000'] + chunk, capture_output=True, text=True).stdout.split('\n')
    for a, r in zip(chunk, out): res[int(a, 16)] = r
by_sym = collections.Counter(); by_line = collections.Counter(); sym_line = {}
for a, c in cnt.items():
    r = res.get(a, '')
    m = re.match(r'(\S+) \(in [^)]+\)(?: \(([^:]+):(\d+)\))?', r)
    sym = m.group(1) if m else '?'
    f, ln = (m.group(2), int(m.group(3))) if m and m.group(2) else ('?', 0)
    by_sym[sym] += c; by_line[(f, ln, sym)] += c
# instruction classes from one streamed objdump
want = set(cnt) | {a - 4 for a in cnt} | {a - 8 for a in cnt}
insn = {}
p = subprocess.Popen(['objdump', '-d', '--no-show-raw-insn', binary], stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
for l in p.stdout:
    m = re.match(r'\s*([0-9a-f]+):\s+(.*)', l)
    if m:
        a = int(m.group(1), 16)
        if a in want: insn[a] = m.group(2).strip()
p.wait()
def cls(a):
    i = insn.get(a, '?'); pv = insn.get(a - 4, ''); pv2 = insn.get(a - 8, '')
    op = i.split()[0] if i != '?' else '?'
    if op in ('stp', 'ldp') and '[sp' in i and re.search(r'\b(x29|x19|x2[0-8]|d8|d9|d1[0-5])\b', i): return 'prologue/epilogue: callee-saved regs'
    if op in ('sub', 'add') and re.match(r'(sub|add)\s+sp,', i): return 'prologue/epilogue: sp'
    if op == 'ret': return 'ret'
    if op == 'bl': return 'bl (direct call)'
    if op in ('blr', 'br'): return 'blr/br (indirect call, jump table)'
    if op.startswith('b.') or op in ('b', 'cbz', 'cbnz', 'tbz', 'tbnz'): return 'branch'
    if op in ('fjcvtzs', 'fcvtzs', 'scvtf', 'ucvtf', 'fcvt', 'fcvtzu'): return 'number conversion (int<->double)'
    if op in ('fcmp', 'fcmpe', 'fccmp'): return 'fcmp'
    if op == 'fmov': return 'fmov (box/unbox move)'
    if op in ('ldr', 'ldur', 'ldp', 'ldrb', 'ldrh', 'ldrsw', 'ldrsb', 'ldrsh'):
        if '[sp' in i or '[x29' in i: return 'load from stack (frame slots, spills)'
        if '#0x7fffffffffff' in pv or '#0x7fffffffffff' in pv2: return 'load after untag (field/element read)'
        return 'load (other: globals, runtime structures)'
    if op in ('str', 'stur', 'stp', 'strb', 'strh'):
        if '[sp' in i or '[x29' in i: return 'store to stack (frame slots, spills)'
        if '#0x7fffffffffff' in pv or '#0x7fffffffffff' in pv2: return 'store after untag (field write)'
        return 'store (other)'
    if op == 'and' and '#0x7fffffffffff' in i: return 'untag pointer'
    if op in ('mov', 'movk', 'movz', 'movn') and re.search(r'#-0x[0-9a-f]{6,}|#0x7ff[0-9a-f]{13}|#0x[0-9a-f]{13,}', i): return 'tag constant materialization'
    if op in ('cmp', 'cmn', 'tst', 'ccmp', 'csel', 'cset', 'csinc', 'cinc', 'csetm', 'csneg', 'cneg'): return 'compare/select'
    if op in ('adrp', 'adr'): return 'adrp/adr (address formation)'
    if op in ('lsr', 'lsl', 'asr', 'ubfx', 'sbfx', 'bfi', 'bfxil', 'extr', 'ror', 'and', 'eor', 'orr', 'bic', 'orn', 'mvn', 'ands', 'eon'): return 'bit ops (tag tests etc.)'
    if op.startswith('f') or op.startswith('dup') or op.startswith('mov.') or op.startswith('ld1') or op.startswith('st1') or op.startswith('cm') and '.' in op: return 'float/vector'
    if op in ('add', 'sub', 'mul', 'madd', 'msub', 'neg', 'sdiv', 'udiv', 'smull', 'umull', 'umulh', 'smulh', 'adds', 'subs', 'mov', 'sxtw', 'uxtw', 'sxth', 'uxth', 'sxtb', 'uxtb', 'smaddl', 'umaddl', 'rev', 'clz', 'rbit'): return 'integer arith/mov'
    if op == '?': return 'unresolved address'
    return 'other: ' + op
hist = collections.Counter(); ex = {}
for a, c in cnt.items():
    k = cls(a); hist[k] += c
    if k not in ex or c > ex[k][0]: ex[k] = (c, insn.get(a - 4, ''), insn.get(a, '?'), res.get(a, '')[:60])
rt = sum(c for (f, ln, s), c in by_line.items() if f in ('ts_rt.c', 'host.c', 'ts_rt.h'))
gen = sum(c for (f, ln, s), c in by_line.items() if f not in ('ts_rt.c', 'host.c', 'ts_rt.h', '?'))
out = sum(outside.values())
print(f"samples {total}: generated code {100*gen/total:.1f}%, runtime (ts_rt.c/host.c) {100*rt/total:.1f}%, system libraries {100*out/total:.1f}%, unresolved {100*(total-gen-rt-out)/total:.1f}%")
print("\n== system library functions, with the nearest caller in the program ==")
callers_by_sym = collections.defaultdict(collections.Counter)
for (r, sym), c in outside_callers.items(): callers_by_sym[sym][r] += c
for (img, sym), c in outside.most_common(12):
    tops = callers_by_sym[sym].most_common(4)
    names = subprocess.run(['atos', '-o', binary, '-l', '0x100000000'] + [hex(r) for r, _ in tops if r], capture_output=True, text=True).stdout.split('\n')
    ni = iter(names)
    desc = ', '.join(f"{100*cc/total:.1f}% {(next(ni) if r else '?')[:70]}" for r, cc in tops)
    print(f"{100*c/total:5.1f}%  {sym:36s} <- {desc}")
print("\n== instruction classes (all samples) ==")
for k, c in hist.most_common():
    e = ex[k]; print(f"{100*c/total:5.1f}%  {k:44s} | {e[1][:28]:28s} ; {e[2][:34]:34s} @ {e[3]}")
print("\n== instruction classes (generated code only) ==")
hg = collections.Counter()
for a, c in cnt.items():
    r = res.get(a, ''); m = re.search(r'\(([^:)]+):(\d+)\)', r)
    if m and m.group(1) not in ('ts_rt.c', 'host.c'): hg[cls(a)] += c
for k, c in hg.most_common(14): print(f"{100*c/gen:5.1f}%  {k}")
print(f"\n== top {top} symbols ==")
for s, c in by_sym.most_common(top): print(f"{100*c/total:5.2f}%  {s}")
print(f"\n== top {top} lines ==")
srcs = {}
def src_line(f, ln):
    if ln <= 0: return ''
    if f not in srcs:
        for cand in (os.path.join(units, f), os.path.join(ROOT, 'runtime', f), os.path.join(ROOT, 'benchmarks', 'tsc_ts_native', f), f):
            if os.path.exists(cand):
                srcs[f] = open(cand, errors='replace').read().split('\n'); break
        else: srcs[f] = []
    L = srcs[f]; return L[ln - 1].strip() if ln - 1 < len(L) else ''
for (f, ln, s), c in by_line.most_common(top): print(f"{100*c/total:5.2f}% {s[:38]:38s} {f}:{ln}  {src_line(f, ln)[:110]}")
