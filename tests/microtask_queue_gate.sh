#!/usr/bin/env bash
# The microtask queue and the promise machinery's ends (Session 358).
# The microtask queue keeps only its pending entries alive (runtime/ts_rt.c microq_push_v): a program
# that is promises only runs inside one drain from start to end, and its memory must not grow with
# the work done. A loop of 2,000,000 awaits (an async call each, a small allocation each) must stay
# under a fixed resident size and finish in time; before the fix it kept every coroutine it had
# resumed alive (and marked it on every collection).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cat > "$W/loop.ts" <<'TS'
async function step(i: number): Promise<number> { await null; return i & 3; }
async function main(): Promise<void> {
  let acc = 0;
  for (let i = 0; i < 2000000; i++) {
    acc += await step(i);
    const o = { a: i, b: [i, i + 1] };
    acc += o.b.length;
  }
  console.log(acc);
}
main();
TS
( cd "$ROOT" && ./garnet --pgo off -o "$W/loop.c" "$W/loop.ts" ) > "$W/build.log" 2>&1 || { echo "[microq] build FAILED"; tail -5 "$W/build.log"; exit 1; }
LIMIT_MB=${TSAOT_MICROQ_RSS_MB:-96}
SECS=${TSAOT_MICROQ_SECS:-60}   # the leak made the run quadratic: a watchdog, not a wait
if [ "$(uname)" = Darwin ]; then
  /usr/bin/time -l perl -e 'alarm shift; exec @ARGV' "$SECS" "$W/loop" > "$W/out.txt" 2> "$W/time.txt"; rc=$?
  rss=$(awk '/maximum resident set size/ {print int($1/1048576)}' "$W/time.txt")
else
  /usr/bin/time -v perl -e 'alarm shift; exec @ARGV' "$SECS" "$W/loop" > "$W/out.txt" 2> "$W/time.txt"; rc=$?
  rss=$(awk -F: '/Maximum resident set size/ {print int($2/1024)}' "$W/time.txt")
fi
out=$(cat "$W/out.txt")
if [ $rc -ne 0 ] || [ "$out" != "7000000" ]; then echo "[microq] FAIL: rc=$rc output=[$out] (expected 7000000; rc 142 is the ${SECS} s watchdog)"; exit 1; fi
if [ "${rss:-0}" -gt "$LIMIT_MB" ]; then echo "[microq] FAIL: max RSS ${rss} MB > ${LIMIT_MB} MB (the queue keeps run coroutines alive)"; exit 1; fi
echo "[microq] PASS: 2,000,000 awaits in one drain, max RSS ${rss} MB (limit ${LIMIT_MB} MB)"

# The promise machinery's ends that a conformance fixture cannot compare (Session 358 review):
# a throw from a queueMicrotask callback is an uncaught exception (status 1, the next job never runs),
# an unhandled rejection's report names the error's message, and many rejections handled together
# take linear time (the unhandled list was quadratic: 40,000 took 366 ms).
build_one() { # <name> <source>
  printf '%s\n' "$2" > "$W/$1.ts"
  ( cd "$ROOT" && ./garnet --pgo off -o "$W/$1.c" "$W/$1.ts" ) > "$W/$1.build.log" 2>&1 || { echo "[microq] FAIL: $1 build"; tail -5 "$W/$1.build.log"; exit 1; }
}
build_one qm_throw 'queueMicrotask(() => { throw new Error("boom"); });
queueMicrotask(() => console.log("second job ran"));'
perl -e 'alarm shift; exec @ARGV' "$SECS" "$W/qm_throw" > "$W/qm.out" 2> "$W/qm.err"; rc=$?
if [ $rc -ne 1 ] || grep -q "second job ran" "$W/qm.out" || ! grep -q "Uncaught exception: Error: boom" "$W/qm.err"; then
  echo "[microq] FAIL: a throwing queueMicrotask callback (rc=$rc, expected 1; stdout=[$(cat "$W/qm.out")], stderr=[$(head -2 "$W/qm.err")])"; exit 1
fi
build_one unhandled 'Promise.reject(new TypeError("the reason"));'
perl -e 'alarm shift; exec @ARGV' "$SECS" "$W/unhandled" > /dev/null 2> "$W/un.err"; rc=$?
if [ $rc -ne 1 ] || ! grep -q "Unhandled promise rejection: TypeError: the reason" "$W/un.err"; then
  echo "[microq] FAIL: the unhandled-rejection report (rc=$rc, stderr=[$(head -2 "$W/un.err")])"; exit 1
fi
build_one rejections 'const ps: Promise<number>[] = [];
for (let i = 0; i < 300000; i++) ps.push(Promise.reject(i));
Promise.allSettled(ps).then((r) => console.log(r.length));'
out=$(perl -e 'alarm 10; exec @ARGV' "$W/rejections" 2>&1); rc=$?
if [ $rc -ne 0 ] || [ "$out" != "300000" ]; then echo "[microq] FAIL: 300,000 rejections handled together (rc=$rc, output=[$out]; rc 142 is the 10 s watchdog: the list is quadratic)"; exit 1; fi
echo "[microq] PASS: a queueMicrotask throw ends the program, the rejection report names the error, 300,000 rejections in linear time"
