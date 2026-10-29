#!/usr/bin/env bash
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
