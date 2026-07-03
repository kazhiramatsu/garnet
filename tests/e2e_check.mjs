import fs from "fs";
const labels = JSON.parse(fs.readFileSync("labels.json","utf8"));
const res = JSON.parse(fs.readFileSync("result.json","utf8"));
const state = {};
for (const s of res.sites) state[s.site] = s.state;
const expected = {
  "o@makeEscaping": "globalEscape",
  "o@keepsLocal": "noEscape",
  "o@leaks": "globalEscape",
  "o@passAndDrop": "noEscape",
  "o@passAndLeak": "globalEscape",
  "inner@holdsThenReturns": "argEscape",
  "outer@holdsThenReturns": "argEscape",
};
let ok = true;
console.log("site                         got           want");
for (const [site, label] of Object.entries(labels)) {
  const got = state[site];
  const want = expected[label];
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`${label.padEnd(26)} ${String(got).padEnd(13)} ${want}  ${pass ? "PASS" : "*** FAIL ***"}`);
}
console.log(ok ? "\nEND-TO-END: ALL PASS" : "\nEND-TO-END: FAILURES");
process.exit(ok ? 0 : 1);
