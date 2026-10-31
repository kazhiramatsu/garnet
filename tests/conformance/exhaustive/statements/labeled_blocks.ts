// `break L` out of a labeled block, and what a plain break or continue means inside one: the enclosing
// loop or switch, past the block. Do-while loops with both.
function first(n: number): string {
  let out = "";
  outer: {
    out += "a";
    if (n === 1) break outer;
    out += "b";
    inner: {
      if (n === 2) break inner;
      if (n === 3) break outer;
      out += "c";
    }
    out += "d";
  }
  return out + "e";
}
console.log(first(0), first(1), first(2), first(3));

function inLoop(): string {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    block: {
      if (i === 1) break block;
      if (i === 2) continue;
      if (i === 4) break;
      out.push("in" + i);
    }
    out.push("after" + i);
  }
  return out.join(",");
}
console.log(inLoop());

function nestedBlocks(): string {
  const out: string[] = [];
  let i = 0;
  while (i < 5) {
    i++;
    a: {
      b: {
        if (i === 1) break a;
        if (i === 2) break b;
        if (i === 3) continue;
        if (i === 4) break;
        out.push("b" + i);
      }
      out.push("a" + i);
    }
    out.push("w" + i);
  }
  return out.join(",");
}
console.log(nestedBlocks());

function inSwitch(k: number): string {
  let out = "";
  switch (k) {
    case 1:
      lab: {
        if (k === 1) break lab;
        out += "x";
      }
      out += "y";
      break;
    case 2:
      lab2: {
        out += "z";
        if (k === 2) break;
        out += "never";
      }
      out += "never2";
      break;
    default:
      out += "d";
  }
  return out;
}
console.log(inSwitch(1), inSwitch(2), inSwitch(3));

function labeledIf(n: number): string {
  let s = "s";
  check: if (n > 0) {
    if (n > 1) break check;
    s += "one";
  }
  return s;
}
console.log(labeledIf(0), labeledIf(1), labeledIf(2));

function withTry(n: number): string {
  let s = "";
  region: {
    try {
      s += "t";
      if (n === 1) break region;
      s += "u";
    } catch (e) {
      s += "c";
    } finally {
      s += "f";
    }
    s += "v";
  }
  return s;
}
console.log(withTry(0), withTry(1));

function loopLabelFromBlock(): string {
  const out: string[] = [];
  outer: for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      b: {
        if (j === 1) continue outer;
        if (i === 2) break outer;
        if (j === 0) break b;
      }
      out.push(i + ":" + j);
    }
  }
  return out.join(",");
}
console.log(loopLabelFromBlock());

function doWhile(): string {
  const out: number[] = [];
  let i = 0;
  do {
    i++;
    if (i === 2) continue;
    if (i === 5) break;
    out.push(i);
  } while (i < 10);
  return out.join(",") + " " + i;
}
console.log(doWhile());

function doBlock(): string {
  const out: number[] = [];
  let i = 0;
  do {
    i++;
    b: {
      if (i === 1) break b;
      if (i === 3) continue;
      if (i === 4) break;
      out.push(i);
    }
    out.push(i * 10);
  } while (i < 9);
  return out.join(",");
}
console.log(doBlock());

function closures(): number {
  const fs: (() => number)[] = [];
  for (let i = 0; i < 3; i++) {
    b: {
      if (i === 1) break b;
      fs.push(() => i);
    }
  }
  return fs.reduce((a, f) => a + f(), 0);
}
console.log(closures());
