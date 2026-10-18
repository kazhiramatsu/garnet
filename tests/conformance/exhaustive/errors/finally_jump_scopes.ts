const trace: string[] = [];
try {
  for (const x of [1, 2]) {
    try {
      switch (x) { case 1: continue; }
      trace.push("body");
    } finally { trace.push("inner:" + x); }
    trace.push("tail");
  }
} finally { trace.push("outer"); }
try {
  try { throw "value"; }
  finally { trace.push("throw-finally"); }
} catch (e) { trace.push("caught:" + e); }
function override(): number {
  try {
    try { return 1; }
    finally { return 2; }
  } finally { trace.push("override-outer"); }
}
console.log(override(), trace.join(","));
