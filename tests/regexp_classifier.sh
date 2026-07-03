#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -d exporter/node_modules ]]; then
  (cd exporter && ./node_modules/.bin/tsc exporter.ts class_extract.ts \
    --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop)
fi

node <<'JS'
const assert = require("assert");
const { classifyRegExpLiteral, splitRegExpLiteral } = require("./exporter/regexp.js");

function plan(raw) {
  return classifyRegExpLiteral(raw);
}
function eq(raw, expected) {
  const got = plan(raw);
  for (const [k, v] of Object.entries(expected)) {
    assert.deepStrictEqual(got[k], v, `${raw}: ${k}`);
  }
}

assert.deepStrictEqual(splitRegExpLiteral(String.raw`/a\/b/g`), { source: String.raw`a\/b`, flags: "g" });

eq(String.raw`/abc/`, { prefix: "abc", anchoredStart: false, sticky: false, global: false, ignoreCase: false, unicodeMode: false, stoppedAt: "end" });
eq(String.raw`/^abc/`, { prefix: "abc", anchoredStart: true, stoppedAt: "end" });
eq(String.raw`/^abc/m`, { prefix: "", anchoredStart: false, stoppedAt: "^" });
eq(String.raw`/abc.*/`, { prefix: "abc", stoppedAt: "." });
eq(String.raw`/a+/`, { prefix: "a", stoppedAt: "+" });
eq(String.raw`/a\/b/g`, { prefix: "a/b", global: true, stoppedAt: "end" });
eq(String.raw`/\x61\u0062/`, { prefix: "ab", stoppedAt: "end" });
eq(String.raw`/\n/`, { prefix: "\n", stoppedAt: "end" });
eq(String.raw`/\u{1f600}/u`, { prefix: "😀", unicodeMode: true, stoppedAt: "end" });
eq(String.raw`/abc/i`, { prefix: "abc", ignoreCase: true, stoppedAt: "end" });
eq(String.raw`/abc/y`, { prefix: "abc", sticky: true, stoppedAt: "end" });
eq(String.raw`/[ab]/`, { prefix: "", stoppedAt: "[" });
eq(String.raw`/\d+/`, { prefix: "", stoppedAt: String.raw`non-literal escape \d` });

console.log("[regexp-classifier] PASS: literal-prefix classifier");
JS
