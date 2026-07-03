// Rich closure end-to-end tests.
// Allocation-site labels:  value object = `name@fn`, cell box = `cell:name@fn`,
// closure object = `hint@fn` (hint = the const/var it is bound to, else `closure`).

let sink: any;
declare function unknownSink(f: any): void;

// 1. Returned closure -> captured cell (box + contents) ArgEscape.
function returnsCounter() {
  let count = {};
  const inc = () => {
    count.x = 1; // references `count` (captures it), no leak
  };
  return inc; // inc escapes via return
}

// 2. Closure created then dropped -> NoEscape.
function dropsClosure() {
  let y = {};
  const h = () => {
    y.z = 1;
  };
  // h is never used
}

// 3. Closure BODY leaks the captured variable to the global sink.
//    -> the captured *value* escapes globally, but the cell box stays local.
function leaksCaptured() {
  let v = {};
  const f = () => {
    sink = v; // leak captured v to global
  };
  // f dropped, but its body still applies at creation (sound)
}

// 4. Closure stored into the global sink -> box + contents GlobalEscape.
function closureToGlobal() {
  let w = {};
  const c = () => {
    w.k = 1;
  };
  sink = c;
}

// 5. Loop-`let` style: closures stored into a returned array via element write.
function loopClosures() {
  const arr = [];
  let k = 0;
  for (let i = 0; i < 3; i = i + 1) {
    let box = {};
    arr[k] = () => {
      box.p = 1;
    };
    k = k + 1;
  }
  return arr; // arr returned -> closures ArgEscape -> boxes ArgEscape
}

// 6. Transitive capture through a nested function (two levels).
function nestedCapture() {
  let outer = {};
  function mid() {
    const inner = () => {
      outer.q = 1; // captures `outer` from the grandparent scope
    };
    return inner;
  }
  return mid;
}

// 7. Exported function returning a closure -> GlobalEscape.
export function makeAdder() {
  let acc = {};
  return () => {
    acc.v = 1;
  };
}

// 8. Non-captured local object -> NoEscape (no cell is created).
function plainLocal() {
  const z = {};
  z.a = 1;
}

// 9. Closure passed to an unknown function -> conservative GlobalEscape.
function closureToUnknown() {
  let m = {};
  const cb = () => {
    m.x = 1;
  };
  unknownSink(cb);
}
