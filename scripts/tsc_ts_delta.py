#!/usr/bin/env python3
"""The delta-port harness of tsc-ts (benchmarks/tsc_ts_native/deltas/README.md).

A delta is one technique another port of the same compiler has (tsrs) and tsc-ts does not: one commit
of the tsc-ts working copy, one patch. What decides it is mechanical, and this tool is that part:

    scripts/tsc_ts_delta.py status                   the catalog: what is a candidate, landed, rejected
    scripts/tsc_ts_delta.py probe <regex>            the share of one thread's samples in the functions
                                                     a technique would shorten (its upper bound)
    scripts/tsc_ts_delta.py new <id> [--base REF]    a git worktree of the working copy for one delta
                                                     (branch delta/<id>): where it is written
    scripts/tsc_ts_delta.py eval [REF] [--base REF] [--corpus none|quick|full] [--wall N]
                                                     the commit against its parent: both built (kept by
                                                     commit), the compiler project's reports compared
                                                     (three option sets, one thread and the default run),
                                                     instructions and cycles on one thread and summed over
                                                     the default run's processes, the corpus; a JSON record
                                                     and a verdict. Exit status 0 exact, 1 not, 2 an error.
    scripts/tsc_ts_delta.py land <id> --name SLUG [--ref REF]
                                                     the working copy's commits as patch files, the delta
                                                     marked landed in the catalog with its record
    scripts/tsc_ts_delta.py reject <id> --reason TEXT

REF is a commit or branch of the working copy, or a delta's id (its branch); HEAD by default.
A build and a run never overlap, nor two evaluations: every step takes one lock, runs at nice 12 with
three jobs, under a time limit. The wall clock is not what a delta is judged by (it follows the
machine's load); `--wall N` adds it for a quiet machine.

Where things are (environment):
    TSC_TS_WORK         the tsc-ts working copy, a clone with the patches as commits (build/tsc-ts-garnet)
    TSC_TS_DELTA_HOME   builds, records, worktrees (build/tsc_ts_delta)
    TSC_TS_PROJECT      the TypeScript checkout whose src/compiler is compiled (build/typescript_603/source)
    TSC_TS_LIB_DIR      the lib directory (build/tsc-ts/node_modules/@scriptc/cli-*/dist/lib/typescript/lib)
    TSC_TS_CORPUS       TypeScript's tests/cases (the corpus; without it the corpus steps are skipped)
"""
import argparse, bisect, collections, glob, hashlib, json, os, re, shutil, statistics, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.environ.get('TSC_TS_DELTA_HOME') or os.path.join(ROOT, 'build', 'tsc_ts_delta')
WORK = os.environ.get('TSC_TS_WORK') or os.path.join(ROOT, 'build', 'tsc-ts-garnet')
PROJECT = os.environ.get('TSC_TS_PROJECT') or os.path.join(ROOT, 'build', 'typescript_603', 'source')
CORPUS = os.environ.get('TSC_TS_CORPUS', '')
DELTAS = os.path.join(ROOT, 'benchmarks', 'tsc_ts_native', 'deltas')
PATCHES = os.path.join(ROOT, 'benchmarks', 'tsc_ts_native', 'patches')
CATALOG = os.path.join(DELTAS, 'catalog.json')
COMMON = ('-p src/compiler/tsconfig.json --composite false --incremental false --declaration false --declarationMap false '
          '--emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false --noEmit').split()
# The option sets whose reports are compared: none reported, 2,229 and 1,510 lines on TypeScript 6.0.3.
VARIANTS = collections.OrderedDict([
    ('default', []),
    ('indexed', ['--noUncheckedIndexedAccess']),
    ('strict3', ['--exactOptionalPropertyTypes', '--noPropertyAccessFromIndexSignature', '--noImplicitOverride']),
])
# What a delta is worth keeping from: instruction counts of one process repeat within 0.1%.
KEEP = 0.002
# The sources whose change is one to how the checkers and the parse threads share work: the corpus then
# also runs with statements shared by force and with function bodies left out by force.
STRUCTURAL = re.compile(r'(parallel-|checker-split|thread-entry|parse-thread|/parser\.ts|/program|checker-source-file|checker-functions)')


def die(message):
    print(f'tsc_ts_delta: {message}', file=sys.stderr)
    sys.exit(2)


def lib_dir():
    lib = os.environ.get('TSC_TS_LIB_DIR')
    if not lib:
        found = sorted(glob.glob(os.path.join(ROOT, 'build', 'tsc-ts', 'node_modules', '@scriptc', 'cli-*', 'dist', 'lib', 'typescript', 'lib')))
        lib = found[0] if found else ''
    if not lib or not os.path.isdir(lib):
        die('no lib directory: set TSC_TS_LIB_DIR')
    return lib


def run(cmd, seconds, env=None, cwd=None, quiet=False):
    """A step at nice 12 under a time limit: (exit status, stdout, stderr)."""
    full = dict(os.environ)
    if env:
        full.update(env)
    try:
        p = subprocess.run(['nice', '-n', '12'] + cmd, capture_output=True, text=True, timeout=seconds, env=full, cwd=cwd, errors='replace')
    except subprocess.TimeoutExpired:
        if not quiet:
            print(f'  timed out after {seconds} s: {" ".join(cmd)[:120]}', file=sys.stderr)
        return 124, '', 'timed out'
    return p.returncode, p.stdout, p.stderr


def git(*args, cwd=WORK):
    p = subprocess.run(['git', '-C', cwd] + list(args), capture_output=True, text=True)
    if p.returncode != 0:
        die(f'git {" ".join(args)}: {p.stderr.strip()}')
    return p.stdout.strip()


class Lock:
    """One build or run at a time, whoever asks: a directory made atomically, with its owner's pid."""

    def __init__(self):
        self.path = os.path.join(HOME, 'lock')

    def __enter__(self):
        os.makedirs(HOME, exist_ok=True)
        waited = False
        while True:
            try:
                os.mkdir(self.path)
                break
            except FileExistsError:
                owner = ''
                try:
                    owner = open(os.path.join(self.path, 'pid')).read().strip()
                    os.kill(int(owner), 0)
                except (OSError, ValueError):
                    # its owner is gone: the lock is taken over
                    try:
                        os.rename(self.path, f'{self.path}.stale.{os.getpid()}.{int(time.time())}')
                    except OSError:
                        pass
                    continue
                if not waited:
                    print(f'  waiting for the lock (held by {owner})', file=sys.stderr)
                    waited = True
                time.sleep(2)
        with open(os.path.join(self.path, 'pid'), 'w') as f:
            f.write(str(os.getpid()))
        return self

    def __exit__(self, *exc):
        try:
            os.unlink(os.path.join(self.path, 'pid'))
            os.rmdir(self.path)
        except OSError:
            pass


def catalog():
    with open(CATALOG) as f:
        return json.load(f)


def save_catalog(c):
    with open(CATALOG, 'w') as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
        f.write('\n')


def entry(c, delta_id):
    for d in c['deltas']:
        if d['id'] == delta_id:
            return d
    die(f'no delta "{delta_id}" in {CATALOG}')


def resolve(ref):
    """A commit of the working copy: a delta's id names its branch."""
    if ref and os.path.exists(CATALOG) and any(d['id'] == ref for d in catalog()['deltas']):
        branches = git('branch', '--list', f'delta/{ref}')
        if branches:
            ref = f'delta/{ref}'
    return git('rev-parse', '--short=12', ref or 'HEAD')


def tree(sha):
    """The tree of the sources at a commit: what a build and a record are kept by, so a commit whose message is rewritten is still the one measured."""
    return git('rev-parse', '--short=12', f'{sha}:packages/tsc-ts/src')


def tree_or_none(sha):
    p = subprocess.run(['git', '-C', WORK, 'rev-parse', '--short=12', f'{sha}:packages/tsc-ts/src'], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def find_record(sha):
    """The record of the sources at `sha` against those of its parent, the one with the most of the corpus."""
    want = (tree(sha), tree(f'{sha}~1'))
    depth = {'none': 0, 'quick': 1, 'full': 2}
    best = None
    for path in glob.glob(os.path.join(HOME, 'evals', '*.json')):
        try:
            r = json.load(open(path))
        except (OSError, ValueError):
            continue
        if 'commit' not in r or 'base' not in r:
            continue
        have = (r.get('tree') or tree_or_none(r['commit']), r.get('base_tree') or tree_or_none(r['base']))
        if have != want:
            continue
        rank = (1 if r.get('exact') else 0, depth.get(r.get('corpus_depth'), 0), r.get('date', ''))
        if best is None or rank > best[0]:
            best = (rank, r, path)
    return (best[1], best[2]) if best else (None, None)


_garnet_key = None


def garnet_key():
    """What of garnet a build depends on, by content: the runtime, the analyzer, the exporter, the libraries, the
    driver and the build script as they are in the working tree, committed or not. (The analyzer and the exporter
    are used as built: build them before an evaluation that follows a change to them.)"""
    global _garnet_key
    if _garnet_key is None:
        paths = ['runtime', 'analyzer/src', 'exporter', 'lib', 'benchmarks/tsc_ts_native/garnet', 'benchmarks/tsc_ts_native/tsconfig.json',
                 'scripts/build_tsc_ts_native.sh']
        names = subprocess.run(['git', '-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'] + paths,
                               capture_output=True).stdout.split(b'\0')
        h = hashlib.sha1()
        for name in sorted(set(n for n in names if n)):
            try:
                with open(os.path.join(ROOT.encode(), name), 'rb') as f:
                    h.update(name + b'\0' + hashlib.sha1(f.read()).digest())
            except OSError:
                pass
        _garnet_key = h.hexdigest()[:10]
    return _garnet_key


def build(sha):
    """The plain native build of commit `sha` of the working copy (the measured flags of the gates): kept by commit."""
    key = garnet_key()
    for name in (tree(sha), sha):
        binary = os.path.join(HOME, 'builds', f'{name}-{key}', 'tsc-ts')
        if os.access(binary, os.X_OK):
            return binary
    out = os.path.join(HOME, 'builds', f'{tree(sha)}-{key}')
    os.makedirs(os.path.join(HOME, 'builds'), exist_ok=True)
    stamp = f'{os.getpid()}.{int(time.time())}'
    src = os.path.join(HOME, 'src', f'{sha}.{stamp}')
    os.makedirs(src)
    archive = subprocess.Popen(['git', '-C', WORK, 'archive', sha, 'packages/tsc-ts/src', 'packages/tsc-ts/package.json'], stdout=subprocess.PIPE)
    untar = subprocess.run(['tar', '-x', '-C', src], stdin=archive.stdout)
    if archive.wait() != 0 or untar.returncode != 0:
        die(f'could not export {sha}')
    partial = f'{out}.partial.{stamp}'
    print(f'  building {sha} ...', file=sys.stderr, flush=True)
    t0 = time.time()
    env = {'TSAOT_TSC_TS_PATCHES': '0', 'TSAOT_PGO': 'off', 'TSAOT_UNITS_JOBS': '3',
           'TSAOT_NATIVE_CC': os.environ.get('TSC_TS_DELTA_CC', 'cc -O2 -gline-tables-only -fomit-frame-pointer')}
    rc, so, se = run([os.path.join(ROOT, 'scripts', 'build_tsc_ts_native.sh'), src, partial], 1800, env=env, cwd=ROOT)
    if rc != 0 or not os.access(os.path.join(partial, 'tsc-ts'), os.X_OK):
        log = os.path.join(HOME, f'build-{sha}.log')
        with open(log, 'w') as f:
            f.write(so + '\n' + se)
        die(f'the build of {sha} failed (exit {rc}): {log}')
    os.rename(partial, out)
    print(f'  built {sha} in {time.time() - t0:.0f} s', file=sys.stderr)
    return os.path.join(out, 'tsc-ts')


def compile_project(binary, extra, one_thread, env=None, seconds=120):
    e = {'TSC_TS_LIB_DIR': lib_dir()}
    if one_thread:
        e['TSAOT_CPUS'] = '1'
    if env:
        e.update(env)
    return run([binary] + COMMON + extra + (['--singleThreaded'] if one_thread else []), seconds, env=e, cwd=PROJECT)


def reports(binary):
    """What the build reports on the compiler project, by option set, on one thread and in the default run."""
    found = {}
    for name, extra in VARIANTS.items():
        for mode, one in (('one', True), ('default', False)):
            rc, so, se = compile_project(binary, extra, one)
            # 0 nothing reported, 1 and 2 diagnostics: anything else is a build that does not run
            if rc not in (0, 1, 2):
                die(f'{binary} {name}/{mode}: exit {rc}: {se.strip()[-300:]}')
            text = f'exit {rc}\n{so}\n{se}'
            found[f'{name}/{mode}'] = {'sha': hashlib.sha1(text.encode()).hexdigest()[:12], 'lines': so.count('\n'), 'exit': rc}
    return found


def timed(binary, extra, one_thread, env=None):
    """One run under /usr/bin/time -l: (instructions, cycles, real seconds, stderr)."""
    e = {'TSC_TS_LIB_DIR': lib_dir()}
    if one_thread:
        e['TSAOT_CPUS'] = '1'
    if env:
        e.update(env)
    rc, so, se = run(['/usr/bin/time', '-l', binary] + COMMON + extra + (['--singleThreaded'] if one_thread else []), 180, env=e, cwd=PROJECT)
    insn = re.search(r'(\d+)\s+instructions retired', se)
    cycles = re.search(r'(\d+)\s+cycles elapsed', se)
    real = re.search(r'([\d.]+) real', se)
    if not insn or not cycles or int(insn.group(1)) < 100_000_000:
        die(f'no counts from {binary} (exit {rc}): {se.strip()[-300:]}')
    return int(insn.group(1)), int(cycles.group(1)), float(real.group(1)) if real else 0.0, se


def one_thread_counts(a, b, rounds):
    """The two builds on one thread, alternating: the least instructions and cycles of each."""
    rows = {'a': [], 'b': []}
    for _ in range(rounds):
        for k, binary in (('a', a), ('b', b)):
            i, c, w, _ = timed(binary, [], True)
            rows[k].append((i, c, w))
    return {k: {'instructions': min(r[0] for r in v), 'cycles': min(r[1] for r in v), 'wall': min(r[2] for r in v)} for k, v in rows.items()}


def default_run_counts(a, b, rounds):
    """The default run's processes, alternating: the medians of the instructions and cycles summed over them."""
    rows = {'a': [], 'b': []}
    child = re.compile(r'^\[fork child\].*instructions ([\d.]+) G, cycles ([\d.]+) G', re.M)
    for _ in range(rounds):
        for k, binary in (('a', a), ('b', b)):
            i, c, w, se = timed(binary, [], False, env={'TSAOT_FORK_TRACE': '1'})
            workers = child.findall(se)
            rows[k].append((i + sum(float(x[0]) for x in workers) * 1e9, c + sum(float(x[1]) for x in workers) * 1e9, len(workers)))
    return {k: {'instructions': statistics.median(r[0] for r in v), 'cycles': statistics.median(r[1] for r in v),
                'processes': statistics.median(r[2] for r in v)} for k, v in rows.items()}


def wall_clock(a, b, rounds):
    rows = {'a': [], 'b': []}
    for _ in range(rounds):
        for k, binary in (('a', a), ('b', b)):
            t0 = time.perf_counter()
            compile_project(binary, [], False)
            rows[k].append((time.perf_counter() - t0) * 1000)
    return {k: {'min_ms': round(min(v), 1), 'median_ms': round(statistics.median(v), 1)} for k, v in rows.items()} | {'load': os.getloadavg()[0]}


def corpus_run(label, a, b, extra, seconds):
    """One comparison over the corpus (scripts/tsc_ts_corpus_diff.py): its summary, parsed."""
    cmd = ['python3', os.path.join(ROOT, 'scripts', 'tsc_ts_corpus_diff.py'), a, b, '--root', CORPUS, '--jobs', '3', '--show', '20'] + extra
    t0 = time.time()
    rc, so, se = run(cmd, seconds, env={'TSC_TS_LIB_DIR': lib_dir()}, cwd=ROOT)
    m = re.search(r'cases (\d+): identical (\d+), differ (\d+)', so)
    count = re.search(r'B wrote ".*?" in (\d+)', so)
    result = {'label': label, 'exit': rc, 'seconds': round(time.time() - t0),
              'cases': int(m.group(1)) if m else 0, 'identical': int(m.group(2)) if m else 0, 'differ': int(m.group(3)) if m else -1,
              'counted': int(count.group(1)) if count else None}
    if rc != 0 or not m or result['differ'] != 0:
        log = os.path.join(HOME, 'evals', f'corpus-{label}-{int(time.time())}.log')
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, 'w') as f:
            f.write(so + '\n' + se)
        result['log'] = log
    print(f'  corpus {label}: {result["identical"]}/{result["cases"]} identical, {result["differ"]} differ ({result["seconds"]} s)', file=sys.stderr, flush=True)
    return result


def corpus_checks(base, cand, depth, structural):
    if depth == 'none' or not CORPUS:
        return []
    limit = ['--limit', '400'] if depth == 'quick' else []
    found = [corpus_run('one-thread', base, cand, limit, 3600)]
    if structural:
        forced = 'TSC_TS_TIMELINE=1,TSC_TS_SPLIT_BODY=0,TSC_TS_SPLIT_MIN=0,TSC_TS_SPLIT_FILE=tests/cases'
        modes = [('forks-3-at-2-fail-2', f'{forced},TSC_TS_SPLIT_FORKS=3,TSC_TS_SPLIT_AT=2,TSC_TS_SPLIT_FAIL=2', 'TSC_TS_SPLIT=0,TSC_TS_SKELETON=0', 'fork start')]
        if depth == 'full':
            modes += [
                ('forks-2-at-0', f'{forced},TSC_TS_SPLIT_FORKS=2,TSC_TS_SPLIT_AT=0', 'TSC_TS_SPLIT=0,TSC_TS_SKELETON=0', 'fork start'),
                ('forks-3-at-5-fail-1', f'{forced},TSC_TS_SPLIT_FORKS=3,TSC_TS_SPLIT_AT=5,TSC_TS_SPLIT_FAIL=1', 'TSC_TS_SPLIT=0,TSC_TS_SKELETON=0', 'fork start'),
                ('bodies-left-out', 'TSC_TS_TIMELINE=1,TSC_TS_SKELETON_BODY=1', 'TSC_TS_SKELETON=0', 'full program'),
                ('bodies-misplaced', 'TSC_TS_TIMELINE=1,TSC_TS_SKELETON_BODY=1,TSC_TS_SKELETON_FAIL=1', 'TSC_TS_SKELETON=0', 'compiling again'),
            ]
        for label, env_b, env_a, count in modes:
            # the candidate against itself: alone and whole, and with the work shared by force
            found.append(corpus_run(label, cand, cand, limit + ['--checkers', '2', '--env-a', env_a, '--env-b', env_b, '--count-b', count], 5400))
    return found


def cmd_eval(args):
    cand = resolve(args.ref)
    base = resolve(args.base) if args.base else git('rev-parse', '--short=12', f'{cand}~1')
    changed = git('diff', '--name-only', base, cand).split('\n')
    structural = any(STRUCTURAL.search(p) for p in changed)
    subject = git('log', '-1', '--format=%s', cand)
    print(f'delta {cand} "{subject}" against {base}{" (structural)" if structural else ""}', file=sys.stderr)
    record = {'commit': cand, 'base': base, 'tree': tree(cand), 'base_tree': tree(base), 'subject': subject, 'files': changed, 'structural': structural,
              'garnet': garnet_key(), 'date': time.strftime('%Y-%m-%d %H:%M'), 'load': round(os.getloadavg()[0], 1)}
    with Lock():
        a = build(base)
        b = build(cand)
        ra, rb = reports(a), reports(b)
        record['reports'] = {k: {'base': ra[k], 'candidate': rb[k], 'same': ra[k]['sha'] == rb[k]['sha']} for k in ra}
        same = all(v['same'] for v in record['reports'].values())
        print(f'  reports: {"identical" if same else "DIFFER: " + ", ".join(k for k, v in record["reports"].items() if not v["same"])}', file=sys.stderr, flush=True)
        one = one_thread_counts(a, b, args.rounds)
        run_ = default_run_counts(a, b, max(args.rounds, 5))
        record['one_thread'] = one | {'instructions_ratio': one['b']['instructions'] / one['a']['instructions'], 'cycles_ratio': one['b']['cycles'] / one['a']['cycles']}
        record['default_run'] = run_ | {'instructions_ratio': run_['b']['instructions'] / run_['a']['instructions'], 'cycles_ratio': run_['b']['cycles'] / run_['a']['cycles']}
        if args.wall:
            record['wall'] = wall_clock(a, b, args.wall)
        record['corpus'] = corpus_checks(a, b, args.corpus if same else 'none', structural)
    corpus_ok = all(c['differ'] == 0 and c['exit'] == 0 for c in record['corpus'])
    record['exact'] = same and corpus_ok
    record['corpus_depth'] = args.corpus if CORPUS and same else 'none'
    r1, r2 = record['one_thread']['instructions_ratio'], record['default_run']['instructions_ratio']
    if not record['exact']:
        verdict = 'NOT EXACT'
    elif min(r1, r2) <= 1 - KEEP and max(r1, r2) <= 1 + KEEP:
        verdict = 'keep'
    elif max(r1, r2) > 1 + KEEP:
        verdict = 'worse' if min(r1, r2) > 1 - KEEP else 'mixed'
    else:
        verdict = 'neutral'
    record['verdict'] = verdict
    os.makedirs(os.path.join(HOME, 'evals'), exist_ok=True)
    path = os.path.join(HOME, 'evals', f'{record["tree"]}-{record["base_tree"]}-{record["corpus_depth"]}.json')
    with open(path, 'w') as f:
        json.dump(record, f, indent=2)
    pct = lambda r: f'{100 * (r - 1):+.2f}%'
    print(f'one thread:  instructions {one["a"]["instructions"] / 1e9:.3f} -> {one["b"]["instructions"] / 1e9:.3f} G ({pct(r1)}), cycles {pct(record["one_thread"]["cycles_ratio"])}')
    print(f'default run: instructions {run_["a"]["instructions"] / 1e9:.3f} -> {run_["b"]["instructions"] / 1e9:.3f} G ({pct(r2)}), cycles {pct(record["default_run"]["cycles_ratio"])}, {run_["b"]["processes"]:.0f} processes')
    if args.wall:
        w = record['wall']
        print(f'wall (load {w["load"]:.1f}): min {w["a"]["min_ms"]} -> {w["b"]["min_ms"]} ms, median {w["a"]["median_ms"]} -> {w["b"]["median_ms"]} ms')
    print(f'reports {"identical" if same else "DIFFER"}; corpus ({record["corpus_depth"]}): ' +
          (', '.join(f'{c["label"]} {c["identical"]}/{c["cases"]}' for c in record['corpus']) or 'not run'))
    print(f'verdict: {verdict}   ({path})')
    return 0 if record['exact'] else 1


def cmd_status(args):
    c = catalog()
    print(f'{"id":30s} {"status":12s} {"tsrs measured":34s} here')
    for d in c['deltas']:
        r = d.get('result') or {}
        here = ''
        if 'one_thread' in r:
            here = f'one thread {100 * (r["one_thread"] - 1):+.2f}%, default run {100 * (r.get("default_run", 1) - 1):+.2f}%'
        if d.get('patch'):
            here += f' [{d["patch"]}]'
        if d.get('reason'):
            here += f' ({d["reason"]})'
        print(f'{d["id"]:30s} {d["status"]:12s} {(d.get("tsrs", {}).get("measured", "") or "")[:34]:34s} {here}')
    counts = collections.Counter(d['status'] for d in c['deltas'])
    print(', '.join(f'{n} {s}' for s, n in counts.most_common()))
    return 0


def cmd_probe(args):
    """The share of one thread's samples in the functions matching the pattern: what a shortcut there can save at most."""
    sha = resolve(args.ref)
    with Lock():
        binary = build(sha)
        os.makedirs(os.path.join(HOME, 'probes'), exist_ok=True)
        pcs = os.path.join(HOME, 'probes', f'{sha}.pcs')
        if not os.path.exists(pcs):
            compile_project(binary, [], True, env={'TSAOT_PROF_PC': pcs, 'TSAOT_PROF_PC_US': '100'}, seconds=300)
    if not os.path.exists(pcs):
        die('the profile was not written (TSAOT_PROF_PC)')
    syms = []
    for l in subprocess.run(['nm', '-n', binary], capture_output=True, text=True).stdout.split('\n'):
        p = l.split()
        if len(p) == 3 and p[1] in 'tT':
            syms.append((int(p[0], 16), p[2].lstrip('_')))
    syms.sort()
    addrs = [a for a, _ in syms]
    lines = open(pcs).read().split('\n')
    slide = int(lines[0].split()[1], 16)
    by = collections.Counter()
    total = 0
    for l in lines[2:]:
        p = l.split()
        if len(p) < 2:
            continue
        n = int(p[1])
        total += n
        if len(p) > 2 and p[2] and p[2] != 'tsc-ts':
            by['[lib] ' + (p[3].split('+')[0] if len(p) > 3 else '?')] += n
            continue
        i = bisect.bisect_right(addrs, int(p[0], 16) - slide) - 1
        by[syms[i][1] if i >= 0 else '?'] += n
    pattern = re.compile(args.pattern)
    hits = [(s, n) for s, n in by.most_common() if pattern.search(s)]
    share = sum(n for _, n in hits)
    print(f'{100 * share / max(total, 1):.2f}% of {total} samples (one thread, commit {sha}) in {len(hits)} functions matching /{args.pattern}/')
    for s, n in hits[:args.top]:
        print(f'  {100 * n / total:5.2f}%  {s}')
    return 0


def cmd_new(args):
    c = catalog()
    entry(c, args.id)
    path = os.path.join(HOME, 'work', args.id)
    if os.path.exists(path):
        die(f'{path} exists')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    git('worktree', 'add', '-b', f'delta/{args.id}', path, args.base or 'HEAD')
    modules = os.path.join(WORK, 'node_modules')
    if os.path.exists(modules):
        os.symlink(os.path.realpath(modules), os.path.join(path, 'node_modules'))
    print(path)
    return 0


def write_patches(names):
    """The working copy's commits above the upstream commit as numbered patch files (the message, then the diff of the sources)."""
    upstream = catalog()['upstream']
    written = []
    for i, commit in enumerate(git('rev-list', '--reverse', f'{upstream}..HEAD').split('\n'), 1):
        number = f'{i:04d}'
        existing = sorted(glob.glob(os.path.join(PATCHES, f'{number}-*.patch')))
        name = names.get(number) or (os.path.basename(existing[0])[5:-6] if existing else None)
        if not name:
            die(f'no name for patch {number} ({git("log", "-1", "--format=%s", commit)}): --name {number}=<slug>')
        text = git('log', '-1', '--format=%B', commit) + '\n' + git('diff', f'{commit}~1', commit, '--', 'packages/tsc-ts/src') + '\n'
        out = os.path.join(PATCHES, f'{number}-{name}.patch')
        if existing and existing[0] != out:
            die(f'patch {number} is {os.path.basename(existing[0])}: rename it by hand before it is written as {os.path.basename(out)}')
        if not os.path.exists(out) or open(out).read() != text:
            with open(out, 'w') as f:
                f.write(text)
            written.append(os.path.basename(out))
    return written


def cmd_land(args):
    c = catalog()
    d = entry(c, args.id)
    sha = resolve(args.ref or args.id)
    r, record = find_record(sha)
    if r is None:
        die(f'{sha} has no record: evaluate it first')
    if not r['exact'] and not args.force:
        die(f'{sha} is not exact ({record})')
    if r['corpus_depth'] != 'full' and not args.force:
        die(f'{sha} was evaluated with the corpus "{r["corpus_depth"]}": land after `eval --corpus full` (or --force)')
    head = git('rev-parse', '--short=12', 'HEAD')
    if subprocess.run(['git', '-C', WORK, 'merge-base', '--is-ancestor', sha, 'HEAD']).returncode != 0:
        # written on a branch of its own (`new`): it joins the patches' branch
        git('cherry-pick', sha)
        print(f'cherry-picked {sha} onto {head}')
    count = len(git('rev-list', f'{c["upstream"]}..HEAD').split('\n'))
    names = dict(n.split('=', 1) for n in args.name if '=' in n)
    for n in args.name:
        if '=' not in n:
            names[f'{count:04d}'] = n
    written = write_patches(names)
    d['status'] = 'landed'
    d['patch'] = next((w[:-6] for w in written if w.startswith(f'{count:04d}-')), d.get('patch'))
    d['result'] = {'commit': sha, 'one_thread': round(r['one_thread']['instructions_ratio'], 4), 'default_run': round(r['default_run']['instructions_ratio'], 4),
                   'corpus': r['corpus_depth'], 'date': r['date']}
    save_catalog(c)
    print('written: ' + (', '.join(written) or 'nothing new'))
    return 0


def cmd_reject(args):
    c = catalog()
    d = entry(c, args.id)
    d['status'] = args.status
    d['reason'] = args.reason
    r = None
    if git('branch', '--list', f'delta/{args.id}'):
        r, _ = find_record(resolve(args.id))
    if r is not None:
        sha = r['commit']
        d['result'] = {'commit': sha, 'one_thread': round(r['one_thread']['instructions_ratio'], 4), 'default_run': round(r['default_run']['instructions_ratio'], 4),
                       'corpus': r['corpus_depth'], 'date': r['date']}
    save_catalog(c)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='command', required=True)
    sub.add_parser('status').set_defaults(run=cmd_status)
    p = sub.add_parser('probe'); p.add_argument('pattern'); p.add_argument('--ref', default=''); p.add_argument('--top', type=int, default=12); p.set_defaults(run=cmd_probe)
    p = sub.add_parser('new'); p.add_argument('id'); p.add_argument('--base', default=''); p.set_defaults(run=cmd_new)
    p = sub.add_parser('eval'); p.add_argument('ref', nargs='?', default=''); p.add_argument('--base', default='')
    p.add_argument('--corpus', choices=['none', 'quick', 'full'], default='quick'); p.add_argument('--rounds', type=int, default=3)
    p.add_argument('--wall', type=int, default=0); p.set_defaults(run=cmd_eval)
    p = sub.add_parser('land'); p.add_argument('id'); p.add_argument('--ref', default=''); p.add_argument('--name', action='append', default=[], required=True)
    p.add_argument('--force', action='store_true'); p.set_defaults(run=cmd_land)
    p = sub.add_parser('reject'); p.add_argument('id'); p.add_argument('--reason', required=True)
    p.add_argument('--status', choices=['rejected', 'present', 'not-applicable', 'candidate'], default='rejected'); p.set_defaults(run=cmd_reject)
    args = ap.parse_args()
    if not os.path.isdir(os.path.join(WORK, '.git')) and not os.path.isfile(os.path.join(WORK, '.git')):
        die(f'no tsc-ts working copy at {WORK}: set TSC_TS_WORK')
    sys.exit(args.run(args))


if __name__ == '__main__':
    main()
