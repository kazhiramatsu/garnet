// break/continue out of a try inside a loop of an async function or generator.
// Two shapes: the try contains an await (so it is lowered with the coroutine
// handler stack) and the try contains no suspension while the enclosing loop
// does. In both, leaving the try must pop its handler; otherwise a throw that
// happens AFTER the loop is routed to the dead try's catch (observed as the
// wrong catch running and the real exception being swallowed), and the no-
// suspension shape used to make the analyzer panic.

async function breakOut(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    try {
      await Promise.resolve(i);
      if (i === 1) break;
    } catch (e) {
      console.log("wrong catch A");
      return -1;
    }
  }
  throw new Error("after break");
}

async function continueOut(): Promise<number> {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    try {
      await Promise.resolve(i);
      if (i < 2) continue;
      n += 10;
    } catch (e) {
      console.log("wrong catch B");
      return -2;
    }
  }
  if (n === 10) throw new Error("after continue");
  return n;
}

async function noSuspensionInTry(n: number): Promise<number> {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    await Promise.resolve(i);
    try {
      if (i === 3) break;
      if (i === 1) continue;
      acc += i;
    } catch (e) {
      acc = -100;
    }
  }
  return acc;
}

async function nestedTryBreak(): Promise<number> {
  for (let i = 0; i < 2; i++) {
    try {
      try {
        await Promise.resolve(i);
        if (i === 0) break;
      } catch (e) {
        console.log("wrong catch C");
      }
    } catch (e2) {
      console.log("wrong catch D");
    }
  }
  throw new Error("after nested");
}

async function throughFinally(): Promise<string> {
  let log = "";
  for (let i = 0; i < 3; i++) {
    try {
      try {
        await Promise.resolve(i);
        if (i === 1) break;
        log += "b" + i;
      } catch (e) {
        log += "wrongE";
      }
    } finally {
      log += "f" + i;
    }
  }
  try {
    throw new Error("late");
  } catch (e: any) {
    log += "|" + e.message;
  }
  return log;
}

function* genBreak(): Generator<number, number, unknown> {
  for (let i = 0; i < 3; i++) {
    try {
      yield i;
      if (i === 1) break;
    } catch (e) {
      console.log("wrong catch G");
      return -3;
    }
  }
  throw new Error("gen after");
}

async function main(): Promise<void> {
  try { await breakOut(); } catch (e: any) { console.log("caught", e.message); }
  try { await continueOut(); } catch (e: any) { console.log("caught", e.message); }
  console.log(await noSuspensionInTry(10));
  try { await nestedTryBreak(); } catch (e: any) { console.log("caught", e.message); }
  console.log(await throughFinally());
  const g = genBreak();
  g.next(); g.next();
  try { g.next(); } catch (e: any) { console.log("caught", e.message); }
  console.log("end");
}
main();
