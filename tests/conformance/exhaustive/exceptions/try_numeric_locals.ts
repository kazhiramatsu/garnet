// A number or boolean local written in a `try` and read where a throw lands. Unboxed, such a local is
// a C local, and one written after the `setjmp` is indeterminate after the `longjmp`: the catch, the
// finally and the code after them read the value from before the `try`, with no error
// (`try_volatile_locals`).
function thrower(x: number): void {
  if (x > 0) throw new Error("x");
}

function readInCatch(k: number): number {
  let n = 0;
  try {
    n = 1;
    thrower(k);
    n = 2;
  } catch (e) {
    return n + 10;
  }
  return n;
}
function readInFinally(k: number): string {
  let flag = false;
  let count = 0;
  let out = "";
  try {
    try {
      flag = true;
      count += 5;
      thrower(k);
      flag = false;
    } finally {
      out = "finally " + flag + " " + count;
    }
  } catch (e) {
    out += " caught";
  }
  return out;
}
function readAfter(k: number): number {
  let n = 0.5;
  try {
    n = 1.5;
    thrower(k);
    n = 2.5;
  } catch (e) {
    n += 10;
  }
  return n;
}
function inLoop(k: number): number {
  let sum = 0;
  for (let i = 0; i < 5; i++) {
    try {
      sum += i;
      thrower(i - k);
      sum += 100;
    } catch (e) {
      sum += 1000;
    }
  }
  return sum;
}
function reenteredByLoop(): number {
  let n = 0;
  for (let i = 0; i < 6; i++) {
    try {
      n = n + 1;
      if (n === 3) throw new Error("three");
    } catch (e) {
      n = n + 10;
    }
  }
  return n;
}
function reenteredNoCatchWrite(): number {
  let n = 0;
  for (let i = 0; i < 6; i++) {
    try {
      n = n + 1;
      if (n % 2 === 0) throw new Error("even");
    } catch (e) {
      continue;
    }
  }
  return n;
}
function nested(k: number): number {
  let n = 0;
  try {
    try {
      n = 1;
      thrower(k);
      n = 2;
    } finally {
      n += 10;
    }
    n += 100;
  } catch (e) {
    n += 1000;
  }
  return n;
}
function innerRethrow(k: number): number {
  let n = 0;
  try {
    try {
      n = 1;
      thrower(k);
    } catch (e) {
      n = 2;
      throw e;
    } finally {
      n += 4;
    }
  } catch (e) {
    n += 8;
  }
  return n;
}
function parameter(n: number, k: number): number {
  try {
    n = n * 2;
    thrower(k);
    n = n + 1;
  } catch (e) {
    return n + 100;
  }
  return n;
}
function boolFlag(k: number): boolean {
  let done = false;
  try {
    thrower(k);
    done = true;
  } catch (e) {
    return done;
  }
  return done;
}
function counterInLoopInTry(k: number): number {
  let i = 0;
  try {
    for (; i < 10; i++) {
      thrower(i - k);
    }
  } catch (e) {
    return i;
  }
  return -1;
}
function fieldScalar(k: number): number {
  const o = { a: 1, b: 2 };
  try {
    o.a = 5;
    thrower(k);
    o.b = 6;
  } catch (e) {
    return o.a * 10 + o.b;
  }
  return o.a * 10 + o.b;
}
function closureCaptured(k: number): number {
  let n = 0;
  const bump = (): void => {
    n += 1;
  };
  try {
    bump();
    n += 1;
    thrower(k);
    n += 1;
  } catch (e) {
    return n;
  }
  return n;
}
class Counter {
  n = 0;
  step(k: number): number {
    let local = 0;
    try {
      this.n++;
      local = this.n;
      thrower(k);
      local = -1;
    } catch (e) {
      return local * 2;
    }
    return local;
  }
}

const calls: [(k: number) => unknown, string][] = [
  [readInCatch, "readInCatch"],
  [readInFinally, "readInFinally"],
  [readAfter, "readAfter"],
  [inLoop, "inLoop"],
  [nested, "nested"],
  [innerRethrow, "innerRethrow"],
  [boolFlag, "boolFlag"],
  [counterInLoopInTry, "counterInLoopInTry"],
  [fieldScalar, "fieldScalar"],
  [closureCaptured, "closureCaptured"],
];
for (const [f, name] of calls) console.log(name, f(0), f(1), f(2));
console.log(reenteredByLoop(), reenteredNoCatchWrite(), parameter(3, 0), parameter(3, 1));
const c = new Counter();
console.log(c.step(0), c.step(1), c.n);
