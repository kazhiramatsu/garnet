// Array.prototype.values / keys / entries are live iterators: a for..of over
// them reads the array's current length at each step (elements pushed during
// the loop are visited, removed ones are not), and as values they are Array
// Iterator objects with next(). Generator objects carry their toStringTag.
function* gen(): Generator<number> { yield 1; }
async function* agen(): AsyncGenerator<number> { yield 1; }
function main(): void {
  const b = [1, 2, 3];
  const s1: number[] = [];
  for (const x of b.values()) { s1.push(x); if (x === 1) b.push(4); }
  const c = [10, 20];
  const s2: string[] = [];
  for (const [i, v] of c.entries()) { s2.push(i + ":" + v); if (i === 0) c.push(30); }
  const d = [5, 6, 7];
  const s3: number[] = [];
  for (const k of d.keys()) { s3.push(k); if (k === 0) d.pop(); }
  console.log(s1.join(","), s2.join(","), s3.join(","));

  // patterns other than two names, an assignment target, holes and undefined
  const e: (number | undefined)[] = [1, , 3, undefined];
  const s4: string[] = [];
  for (const pair of e.entries()) s4.push(JSON.stringify(pair));
  for (const [i, v = 99] of e.entries()) s4.push(i + "=" + v);
  let gi = -1, gv: number | undefined = -1;
  for ([gi, gv] of e.entries()) s4.push(gi + "/" + gv);
  for (const [i] of e.entries()) s4.push("k" + i);
  console.log(s4.join(" "));

  // as values: next(), spread, Array.from, toString tags
  const f = ["a", "b"];
  const it = f.values();
  console.log(Object.prototype.toString.call(it), JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()));
  const ki = f.keys(), en = f.entries();
  console.log(JSON.stringify(ki.next()), JSON.stringify(en.next()), [...f.entries()].join("|"), Array.from(f.keys()).join(","));
  const live = f.values();
  f.push("c");
  console.log([...live].join(","), [...f.keys()].length);
  console.log(Object.prototype.toString.call(gen()), Object.prototype.toString.call(agen()));

  // dynamic receivers
  const anyArr: any = [7, 8];
  const dynVals: any[] = [];
  for (const v of anyArr.values()) dynVals.push(v);
  console.log(dynVals.join(","), JSON.stringify(anyArr.entries().next()), [...anyArr.keys()].join(","));

  // a long loop at one site
  const big: number[] = [];
  for (let i = 0; i < 2000; i++) big.push(i);
  let sum = 0;
  for (const [i, v] of big.entries()) { sum += i * 2 + v; if (i === 1000) big.length = 1500; }
  console.log(sum);
}
main();
