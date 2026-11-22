#!/usr/bin/env python3
"""Two tsc-ts builds over TypeScript's own test cases: what each prints and its exit status, compared.

    scripts/tsc_ts_corpus_diff.py <binary A> <binary B> --root <TypeScript checkout>/tests/cases
        [--dirs compiler,conformance] [--limit N] [--jobs N] [--checkers K] [--timeout S] [--show N]
        [--env-a KEY=VALUE,...] [--env-b KEY=VALUE,...] [--count-b TEXT]

A change to tsc-ts that must not change what the compiler reports (benchmarks/tsc_ts_native/patches)
passes when no case differs. Every test file is one compile, type check only, with the options below; the
`// @` directives of a case are comments to both builds, so a case is its text as one file. `--limit N` takes
N cases spread evenly over the sorted list. One thread by default (`--singleThreaded`); `--checkers K` runs
the forked checkers instead. The lib directory is TSC_TS_LIB_DIR, or the tsc-ts checkout's under build/.
`--env-a` and `--env-b` add to the environment of each side: one build under two settings (A and B may be
the same binary), such as a checker's statements shared with forks of itself against a checker alone.
`--count-b TEXT` counts the cases in which B wrote TEXT to stderr (with TSC_TS_TIMELINE=1 in `--env-b`,
"fork start": the cases whose statements were in fact shared).
Exit status 1 when a case differs. Prints how many cases report a diagnostic (a corpus that reports none
compares nothing) and a hash of A's output, to tell two runs of the same build apart from two builds."""
import argparse, concurrent.futures, glob, hashlib, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('a'); ap.add_argument('b')
ap.add_argument('--root', default=os.environ.get('TSC_TS_CORPUS', ''), help="TypeScript's tests/cases (or TSC_TS_CORPUS)")
ap.add_argument('--dirs', default='compiler')
ap.add_argument('--limit', type=int, default=0)
ap.add_argument('--jobs', type=int, default=3)
ap.add_argument('--checkers', type=int, default=0)
ap.add_argument('--timeout', type=float, default=60)
ap.add_argument('--show', type=int, default=8)
ap.add_argument('--env-a', default='')
ap.add_argument('--env-b', default='')
ap.add_argument('--count-b', default='')
args = ap.parse_args()
if not os.path.isdir(args.root): sys.exit("--root: TypeScript's tests/cases directory is needed (or TSC_TS_CORPUS)")
env = dict(os.environ)
if 'TSC_TS_LIB_DIR' not in env:
    libs = glob.glob(os.path.join(ROOT, 'build/tsc-ts/node_modules/@scriptc/cli-*/dist/lib/typescript/lib'))
    if not libs: sys.exit('TSC_TS_LIB_DIR is not set and build/tsc-ts has no @scriptc package')
    env['TSC_TS_LIB_DIR'] = libs[0]
env['TSAOT_CPUS'] = '1'
def side_env(text):
    e = dict(env)
    for kv in filter(None, text.split(',')):
        k, _, v = kv.partition('=')
        e[k] = v
    return e
env_a, env_b = side_env(args.env_a), side_env(args.env_b)
files = []
for d in args.dirs.split(','):
    for base, _, names in os.walk(os.path.join(args.root, d)):
        files += [os.path.join(base, n) for n in names if n.endswith(('.ts', '.tsx'))]
files.sort()
if args.limit and args.limit < len(files): files = files[::len(files) // args.limit][:args.limit]
mode = ['--singleThreaded'] if args.checkers == 0 else ['--checkers', str(args.checkers)]

def run(binary, f, side):
    try:
        p = subprocess.run([binary, '--noEmit', '--pretty', 'false', '--strict', '--target', 'es2022'] + mode + [f],
                           capture_output=True, env=side, timeout=args.timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -999, b'', b'TIMEOUT'

t0 = time.time()
same = differ = reporting = abnormal = counted = 0
shown = []
digest = hashlib.sha256()
with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
    for f, ra, rb in pool.map(lambda f: (f, run(args.a, f, env_a), run(args.b, f, env_b)), files):
        if ra[0] not in (0, 1, 2) or rb[0] not in (0, 1, 2): abnormal += 1
        if ra[1].strip(): reporting += 1
        if args.count_b and args.count_b.encode() in rb[2]: counted += 1
        digest.update(ra[1])
        if ra[0] == rb[0] and ra[1] == rb[1]: same += 1
        else:
            differ += 1
            if len(shown) < args.show: shown.append((f, ra, rb))
print(f'cases {len(files)}: identical {same}, differ {differ}; reporting diagnostics (A) {reporting}; '
      f'abnormal exits {abnormal}; A output sha {digest.hexdigest()[:12]}; {time.time() - t0:.0f} s'
      + (f'; B wrote "{args.count_b}" in {counted}' if args.count_b else ''))
for f, ra, rb in shown:
    print('--- DIFF', os.path.relpath(f, args.root), 'exit', ra[0], rb[0])
    la = ra[1].decode('utf8', 'replace').split('\n'); lb = rb[1].decode('utf8', 'replace').split('\n')
    for x, y in zip(la + [''] * len(lb), lb + [''] * len(la)):
        if x != y:
            print('  A:', x[:200]); print('  B:', y[:200]); break
    if ra[2] != rb[2]: print('  stderr A:', ra[2][-200:], ' B:', rb[2][-200:])
sys.exit(1 if differ else 0)
