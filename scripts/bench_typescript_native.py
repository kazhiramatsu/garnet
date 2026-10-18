#!/usr/bin/env python3
"""Time the generated compiler only after comparing exit status and emitted files."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", required=True, type=pathlib.Path)
    parser.add_argument("--node-tsc", required=True, type=pathlib.Path)
    parser.add_argument("--baseline-native", type=pathlib.Path)
    parser.add_argument("--cwd", required=True, type=pathlib.Path)
    parser.add_argument("--work", required=True, type=pathlib.Path)
    parser.add_argument("--runs", default=3, type=int)
    parser.add_argument("--timeout", default=180, type=float)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    opts = parser.parse_args()
    if opts.runs < 1 or opts.timeout <= 0:
        parser.error("runs and timeout must be positive")
    native, node_tsc, cwd, work = (
        item.resolve() for item in (opts.native, opts.node_tsc, opts.cwd, opts.work)
    )
    work.mkdir(parents=True, exist_ok=True)
    # Never remove an existing user's output directory; every invocation owns a
    # fresh directory below work, and only that directory's output is cleared.
    import tempfile
    session = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=work))
    output = session / "output"
    args = opts.args[1:] if opts.args[:1] == ["--"] else opts.args
    args = [*args, "--outDir", str(output), "--pretty", "false"]
    commands = {"node": ["node", str(node_tsc), *args]}
    if opts.baseline_native:
        commands["baseline-native"] = [str(opts.baseline_native.resolve()), *args]
    commands["native"] = [str(native), *args]
    env = dict(os.environ, NODE_DISABLE_COMPILE_CACHE="1", GARNET_TSC_LIB_DIR=str(node_tsc.parent))
    report = dict(commands=commands, cwd=str(cwd), runs=opts.runs, samples=[])

    def run(kind, name, command=None, expected_exit=0):
        if output.exists():
            shutil.rmtree(output)
        timed_out = threading.Event()
        started = time.perf_counter()
        with (session / f"{name}.stdout").open("wb") as stdout, \
             (session / f"{name}.stderr").open("wb") as stderr:
            proc = subprocess.Popen(command or commands[kind], cwd=cwd, env=env,
                                    stdout=stdout, stderr=stderr, start_new_session=True)

            def expire():
                timed_out.set()
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

            timer = threading.Timer(opts.timeout, expire)
            timer.start()
            try:
                _, status, usage = os.wait4(proc.pid, 0)
                proc.returncode = os.waitstatus_to_exitcode(status)
            finally:
                timer.cancel()
                timer.join()
        elapsed = time.perf_counter() - started
        manifest = {str(file.relative_to(output)): hashlib.sha256(file.read_bytes()).hexdigest()
                    for file in sorted(output.rglob("*")) if file.is_file()}
        sample = dict(kind=kind, name=name, returncode=proc.returncode, timed_out=timed_out.is_set(),
                      wall_seconds=elapsed, user_seconds=usage.ru_utime,
                      system_seconds=usage.ru_stime,
                      maxrss_bytes=usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                      emitted_files=len(manifest))
        report["samples"].append(sample)
        (session / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        if proc.returncode != expected_exit or timed_out.is_set():
            raise RuntimeError(f"{name} failed; see {session / (name + '.stderr')}")
        return manifest, (session / f"{name}.stdout").read_bytes()

    invalid = session / "invalid.ts"
    invalid.write_text('const invalidValue: number = "must report TS2322";\n')
    diagnostic_args = ["--ignoreConfig", str(invalid), "--noEmit", "--pretty", "false",
                       "--skipLibCheck", "--strict", "--target", "es2020"]
    diagnostic = run("node", "validate-node", ["node", str(node_tsc), *diagnostic_args], 2)
    if b"TS2322" not in diagnostic[1]:
        raise RuntimeError(f"Reference diagnostic check failed; logs: {session}")
    for kind in commands:
        if kind != "node" and run(kind, f"validate-{kind}", [commands[kind][0], *diagnostic_args], 2) != diagnostic:
            raise RuntimeError(f"{kind} diagnostics differ from Node; logs: {session}")
    report["diagnostic_matches"] = True
    valid = session / "valid.ts"
    valid.write_text('''interface Point { x: number }
const point: Point = { x: 1 };
const value: number = point.x;
const enum Kind { Left, Right }
type Either = { kind: Kind.Left; left: number } | { kind: Kind.Right; right: number };
function read(input: Either): number {
  switch (input.kind) { case Kind.Left: return input.left; case Kind.Right: return input.right; }
}
interface Host { callback?(): void }
function invoke(host: Host): void { if (host.callback) host.callback(); }
const map = new Map<string, number>();
map.set("x", value);
''')
    valid_args = ["--ignoreConfig", str(valid), "--noEmit", "--pretty", "false",
                  "--skipLibCheck", "--strict", "--target", "es2020"]
    positive = run("node", "validate-positive-node", ["node", str(node_tsc), *valid_args])
    for kind in commands:
        if kind != "node" and run(kind, f"validate-positive-{kind}", [commands[kind][0], *valid_args]) != positive:
            raise RuntimeError(f"{kind} positive type check differs from Node; logs: {session}")
    report["positive_check_matches"] = True
    expected = run("node", "warmup-node")
    for kind in commands:
        if kind != "node" and run(kind, f"warmup-{kind}") != expected:
            raise RuntimeError(f"{kind} output differs from Node; logs: {session}")
    for index in range(opts.runs):
        order = list(commands) if index % 2 == 0 else list(reversed(commands))
        for kind in order:
            if run(kind, f"{index + 1}-{kind}") != expected:
                raise RuntimeError(f"{kind} output changed; logs: {session}")
    medians = {kind: statistics.median(sample["wall_seconds"] for sample in report["samples"]
                                     if sample["kind"] == kind and sample["name"][0].isdigit())
               for kind in commands}
    report.update(median_wall_seconds=medians, native_speedup=medians["node"] / medians["native"],
                  output_matches=True, emitted_files=len(expected[0]))
    if opts.baseline_native:
        report["runtime_speedup"] = medians["baseline-native"] / medians["native"]
    (session / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(dict(result=str(session / "result.json"), **report), indent=2))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error))
