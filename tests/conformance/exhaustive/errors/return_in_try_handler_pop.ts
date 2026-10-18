// A `return` from inside a `try` body (or a nested try, or a try inside a loop)
// leaves the function without ever reaching the end of the try statement. The
// handlers pushed for those try statements must be popped on that path too;
// otherwise a later throw in the CALLER unwinds into the dead frame instead of
// the caller's own catch (observed as the catch being skipped, or a crash).

function f(x: number): number {
  try {
    if (x > 0) return 1;
  } catch (e) {
    return -1;
  }
  return 0;
}

function g(x: number): number {
  try {
    try {
      if (x > 0) return 2;
    } catch (e) {
      return -2;
    }
  } catch (e2) {
    return -3;
  }
  return 0;
}

function h(x: number): number {
  for (let i = 0; i < 3; i++) {
    try {
      if (i === x) return i;
    } catch (e) {
      return -4;
    }
  }
  return 0;
}

function fromCatch(x: number): number {
  try {
    if (x > 0) throw new Error("inner");
  } catch (e) {
    try {
      if (x > 0) return 3;
    } catch (e2) {
      return -5;
    }
  }
  return 0;
}

function main(): void {
  console.log(f(1), g(1), h(1), fromCatch(1));
  // The throw must reach THIS catch, not a stale handler left by f/g/h.
  try {
    f(1); g(1); h(1); fromCatch(1);
    throw new Error("y");
  } catch (e: any) {
    console.log("caught", e.message);
  }
  // Same when the returning function is the last thing before an uncaught-at-
  // this-level throw nested one call deeper.
  function thrower(): void { f(1); throw new Error("z"); }
  try {
    thrower();
  } catch (e: any) {
    console.log("caught", e.message);
  }
  console.log("end");
}
main();
