"use strict";
const assert = require("node:assert/strict");
const { toWireProgram } = require("../exporter/wire_program.js");

for (const text of ["", "ascii", "\0é漢", "😀", "\ud800", "\udfff", "a\ud800z", "\ud800\ud800", "\udc00\ud800"]) {
  const malformed = !text.isWellFormed();
  const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  const input = {
    fields: [{ id: 0, name: text, declaringType: 7 }],
    functions: [{ body: [
      { kind: "Const", value: { kind: "Str", value: text } },
      { kind: "ObjectDefineProp", propName: text, enumerable: true },
    ] }],
  };
  const original = JSON.stringify(input);
  const output = toWireProgram(input);
  assert.deepEqual(output.fields[0], malformed
    ? { id: 0, nameUnits: units, declaringType: 7 }
    : { id: 0, name: text, declaringType: 7 });
  assert.deepEqual(output.functions[0].body[0].value, malformed
    ? { kind: "Str16", units } : { kind: "Str", value: text });
  assert.deepEqual(output.functions[0].body[1], malformed
    ? { kind: "ObjectDefineProp", enumerable: true, propNameUnits: units }
    : { kind: "ObjectDefineProp", propName: text, enumerable: true });
  assert.equal(JSON.stringify(input), original, "conversion must not mutate the IR");
}
assert.throws(() => toWireProgram({ fields: [], functions: [{ name: "\ud800" }] }),
  /unpaired surrogate escaped Str16 conversion at \$\.functions\[0\]\.name/);
// Replacement fields are normalized before validating their discarded strings.
assert.deepEqual(toWireProgram({ fields: [], item: {
  propName: "\ud800", propNameUnits: "\udfff",
} }), { fields: [], item: { propNameUnits: [0xd800] } });
console.log("[wire-program] PASS: UTF-16 conversion, validation paths and input immutability");
