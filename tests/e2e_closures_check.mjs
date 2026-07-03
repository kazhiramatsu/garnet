import fs from "fs";
const labels = JSON.parse(fs.readFileSync("cl_labels.json","utf8"));
const res = JSON.parse(fs.readFileSync("cl_result.json","utf8"));
const state = {}; for (const s of res.sites) state[s.site]=s.state;
const G="globalEscape",A="argEscape",N="noEscape";
const expected = {
  "cell:count@returnsCounter": A, "count@returnsCounter": A, "inc@returnsCounter": A,
  "cell:y@dropsClosure": N, "y@dropsClosure": N, "h@dropsClosure": N,
  "cell:v@leaksCaptured": N, "v@leaksCaptured": G, "f@leaksCaptured": N,
  "cell:w@closureToGlobal": G, "w@closureToGlobal": G, "c@closureToGlobal": G,
  "cell:box@loopClosures": A, "box@loopClosures": A, "arr@loopClosures": A, "closure@loopClosures": A,
  "cell:outer@nestedCapture": A, "outer@nestedCapture": A, "mid@nestedCapture": A, "inner@mid": A,
  "cell:acc@makeAdder": G, "acc@makeAdder": G, "closure@makeAdder": G,
  "z@plainLocal": N,
  "cell:m@closureToUnknown": G, "m@closureToUnknown": G, "cb@closureToUnknown": G,
};
let ok=true, pass=0, fail=0;
console.log("label                              got           want");
for (const [site,label] of Object.entries(labels)) {
  if (!(label in expected)) { console.log(`(unchecked) ${label} = ${state[site]}`); continue; }
  const got=state[site], want=expected[label], p=got===want; if(p)pass++;else{fail++;ok=false;}
  console.log(`${label.padEnd(34)} ${String(got).padEnd(13)} ${want}  ${p?"PASS":"*** FAIL ***"}`);
}
console.log(`\n${pass} pass, ${fail} fail -> ${ok?"END-TO-END CLOSURES: ALL PASS":"FAILURES"}`);
process.exit(ok?0:1);
