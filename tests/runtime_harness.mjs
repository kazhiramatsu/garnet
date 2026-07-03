// Runtime soundness harness.
//
// Validates the analyzer empirically: every allocation site the analysis marked
// NoEscape must, at runtime, be UNREACHABLE from any escape root — (a) the value
// returned out of the frame that created it, and (b) the global sink — both at
// that frame's exit and at program end. A NoEscape object that is reachable from
// an escape root proves the analysis was UNSOUND (a miscompile if we had
// stack-allocated it).
//
// Programs are written in cell-lowered form (cells and closures are explicit
// objects), mirroring the exporter's lowering, so the runtime object graph
// matches the IR semantics and the reachability walk can see captured state.
//
// Usage: node runtime_harness.mjs   (reads cl_report.json + cl_labels.json)

import fs from "fs";

const report = JSON.parse(fs.readFileSync("cl_report.json", "utf8"));
const labels = JSON.parse(fs.readFileSync("cl_labels.json", "utf8"));
const stateOf = {}; // label -> state
{
  const bySite = {};
  for (const s of report.sites) bySite[s.site] = s.state;
  for (const [site, label] of Object.entries(labels)) stateOf[label] = bySite[site];
}

function reachable(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== "object" || seen.has(o)) continue;
    seen.add(o);
    if (Array.isArray(o)) for (const e of o) stack.push(e);
    else for (const k of Object.keys(o)) stack.push(o[k]); // enumerable own props only
  }
  return seen;
}

class Harness {
  constructor(noEscape) {
    this.no = new Set(noEscape); // labels claimed NoEscape
    this.objs = []; // {obj, label, frame}
    this.frame = 0;
    this.sink = {}; // the global sink (an escape root)
    this.violations = [];
  }
  alloc(label, obj) {
    Object.defineProperty(obj, "__site", { value: label, enumerable: false, configurable: true });
    this.objs.push({ obj, label, frame: this.frame });
    return obj;
  }
  enter() {
    return ++this.frame;
  }
  // At a frame's exit, a NoEscape object born in it must not be reachable from rv.
  exitReturn(fid, rv) {
    const reach = reachable([rv]);
    for (const o of this.objs) {
      if (o.frame === fid && this.no.has(o.label) && reach.has(o.obj)) {
        this.violations.push(`NoEscape '${o.label}' escaped via return of frame ${fid}`);
      }
    }
  }
  finalCheck() {
    const reach = reachable([this.sink]);
    for (const o of this.objs) {
      if (this.no.has(o.label) && reach.has(o.obj)) {
        this.violations.push(`NoEscape '${o.label}' reachable from the global sink`);
      }
    }
  }
}

// ----- cell-lowered, instrumented programs (mirror closures.ts) -----
function runPrograms(H) {
  const cell = (label) => H.alloc(label, { value: null });
  const closure = (label, cells, body) => {
    const c = H.alloc(label, { __cells: cells, call: body });
    return c;
  };

  // returnsCounter: returns a closure capturing count (ArgEscape).
  (function () {
    const fid = H.enter();
    const cCount = cell("cell:count@returnsCounter");
    cCount.value = H.alloc("count@returnsCounter", {});
    const inc = closure("inc@returnsCounter", [cCount], () => { cCount.value.x = 1; });
    H.exitReturn(fid, inc);
  })();

  // dropsClosure: closure created then dropped (all NoEscape).
  (function () {
    const fid = H.enter();
    const cY = cell("cell:y@dropsClosure");
    cY.value = H.alloc("y@dropsClosure", {});
    const h = closure("h@dropsClosure", [cY], () => { cY.value.z = 1; });
    void h;
    H.exitReturn(fid, undefined);
  })();

  // leaksCaptured: closure body leaks the captured VALUE to the global sink.
  // Box (cell:v) and closure (f) stay local; only v's value escapes.
  (function () {
    const fid = H.enter();
    const cV = cell("cell:v@leaksCaptured");
    cV.value = H.alloc("v@leaksCaptured", {});
    const f = closure("f@leaksCaptured", [cV], () => { H.sink.leaked = cV.value; });
    f.call(); // invoke -> body runs the leak
    H.exitReturn(fid, undefined);
  })();

  // closureToGlobal: the closure itself is stored into the global sink.
  (function () {
    const fid = H.enter();
    const cW = cell("cell:w@closureToGlobal");
    cW.value = H.alloc("w@closureToGlobal", {});
    const c = closure("c@closureToGlobal", [cW], () => { cW.value.k = 1; });
    H.sink.c = c;
    H.exitReturn(fid, undefined);
  })();

  // loopClosures: closures stored into a returned array (ArgEscape).
  (function () {
    const fid = H.enter();
    const arr = H.alloc("arr@loopClosures", []);
    for (let i = 0; i < 3; i++) {
      const cBox = cell("cell:box@loopClosures");
      cBox.value = H.alloc("box@loopClosures", {});
      const cl = closure("closure@loopClosures", [cBox], () => { cBox.value.p = 1; });
      arr.push(cl);
    }
    H.exitReturn(fid, arr);
  })();

  // plainLocal: a non-captured local object that never escapes (NoEscape).
  (function () {
    const fid = H.enter();
    const z = H.alloc("z@plainLocal", {});
    z.a = 1;
    H.exitReturn(fid, undefined);
  })();

  // closureToUnknown: closure handed to an opaque sink (GlobalEscape).
  (function () {
    const fid = H.enter();
    const cM = cell("cell:m@closureToUnknown");
    cM.value = H.alloc("m@closureToUnknown", {});
    const cb = closure("cb@closureToUnknown", [cM], () => { cM.value.x = 1; });
    H.sink.cb = cb; // unknownSink retains it
    H.exitReturn(fid, undefined);
  })();
}

// ----- positive run: trust the analyzer's NoEscape set -----
const noEscapeLabels = Object.entries(stateOf).filter(([, s]) => s === "noEscape").map(([l]) => l);
const H = new Harness(noEscapeLabels);
runPrograms(H);
H.finalCheck();

console.log(`Checked NoEscape sites: ${noEscapeLabels.length}`);
console.log(`  ${noEscapeLabels.join(", ")}`);
if (H.violations.length === 0) {
  console.log("RUNTIME SOUNDNESS: PASS — no NoEscape object reached an escape root.\n");
} else {
  console.log("RUNTIME SOUNDNESS: FAIL");
  for (const v of H.violations) console.log("  - " + v);
  console.log("");
}

// ----- negative control: deliberately mislabel an escaping site as NoEscape -----
// `inc@returnsCounter` is really ArgEscape (returned). If we claim it NoEscape,
// the harness MUST catch it — proving the check has teeth.
const tampered = [...noEscapeLabels, "inc@returnsCounter"];
const H2 = new Harness(tampered);
runPrograms(H2);
H2.finalCheck();
const caught = H2.violations.some((v) => v.includes("inc@returnsCounter"));
console.log("Negative control (mislabel inc@returnsCounter as NoEscape):");
console.log(caught ? "  harness correctly flagged the unsound label -> PASS" : "  harness MISSED it -> FAIL");

const ok = H.violations.length === 0 && caught;
console.log(`\n${ok ? "HARNESS OK" : "HARNESS PROBLEM"}`);
process.exit(ok ? 0 : 1);
