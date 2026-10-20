// Integer locals whose bits look like heap references, held in coroutine
// frames across suspension points while minor and full collections run
// (docs/gc_v2_design.md §6.5 step 2b). Without the frame map the collector
// scanned a frame conservatively and a full collection dereferenced such an
// integer as the address of an old cell.

// Promoted garbage: the arrays outlive the minor collections of the loop,
// then die together, so the old generation grows past the full threshold.
function churn(n: number): number {
  const keep: number[][] = [];
  for (let i = 0; i < n; i++) keep.push([i, i + 1, i + 2]);
  let s = 0;
  for (let i = 0; i < keep.length; i += 997) s += keep[i][1];
  return s;
}

async function asyncHold(k: number): Promise<string> {
  let a = -2251799813685248 + 4096 + k; // the bits of an object reference
  let b = -1970324836970496 + k;        // of a string reference
  let c = -1688849860259840 + k;        // of a function reference
  let d = -2251799813685245 + k;        // of a handle
  let e = -2111062325321728 + k;        // of a stack-tagged reference
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    await null;
    acc += churn(120000);
    a += 1; b += 1; c += 1; d += 1; e += 1;
  }
  return [a, b, c, d, e, acc].join(" ");
}

function* genHold(k: number): Generator<number, string, number> {
  let a = -2251799813685248 + 8192 + k;
  let b = -1970324836970496 + 8192 + k;
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const got = yield a;
    total += got;
    a += 2; b += 2;
  }
  return [a, b, total].join(" ");
}

async function* agenHold(k: number): AsyncGenerator<number, string, undefined> {
  let a = -1970324836970496 + 12288 + k;
  let c = -1688849860259840 + 12288 + k;
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    await null;
    acc += churn(120000);
    yield c;
    a += 3; c += 3;
  }
  return [a, c, acc].join(" ");
}

async function main(): Promise<void> {
  console.log("async", await asyncHold(1));

  const g = genHold(2);
  const seen: number[] = [];
  let r = g.next(0);
  while (!r.done) {
    seen.push(r.value);
    r = g.next(churn(120000));
  }
  console.log("gen", seen.join(" "), "|", r.value);

  const ag = agenHold(3);
  const got: number[] = [];
  let ar = await ag.next();
  while (!ar.done) {
    got.push(ar.value);
    ar = await ag.next();
  }
  console.log("agen", got.join(" "), "|", ar.value);
}
main();
