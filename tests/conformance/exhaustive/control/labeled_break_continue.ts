// Labeled multi-level break/continue: `break L` / `continue L` targeting an
// enclosing (non-innermost) loop.
function main(): void {
  // break to an outer loop from a nested loop.
  let r = "";
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i + j >= 3) break outer;
      r += i + "" + j + " ";
    }
  }
  console.log(r.trim());                 // 00 01 02 10

  // continue to an outer while loop.
  let s = "";
  let i = 0;
  top: while (i < 3) {
    i++;
    let j = 0;
    while (j < 3) {
      j++;
      if (j === 2) continue top;
      s += i + "" + j + " ";
    }
    s += "end ";
  }
  console.log(s.trim());                 // 11 21 31

  // 3-level: break the outermost from the innermost.
  let t = "";
  a: for (let x = 0; x < 2; x++) b: for (let y = 0; y < 2; y++) for (let z = 0; z < 5; z++) {
    if (z === 1) break a;
    t += x + "" + y + "" + z + " ";
  }
  console.log(t.trim());                 // 000

  // continue to an outer for-with-incrementor loop.
  let sum = 0;
  c: for (let k = 0; k < 3; k++) {
    for (let m = 0; m < 3; m++) {
      if (m === 1) continue c;
      sum += 10;
    }
    sum += 1;
  }
  console.log(sum);                      // 30

  // break to an outer loop from inside a switch.
  let sw = "";
  d: for (let n = 0; n < 4; n++) {
    switch (n) {
      case 2: break d;
      default: sw += n;
    }
  }
  console.log(sw);                       // 01

  // labeled break/continue to the innermost loop still works (degenerate).
  let inn = "";
  e: for (let p = 0; p < 3; p++) { if (p === 1) continue e; inn += p; }
  console.log(inn);                      // 02
}

main();
