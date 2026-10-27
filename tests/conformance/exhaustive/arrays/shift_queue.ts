// Array.prototype.shift and unshift as a queue and a deque (rxjs's mergeMap buffer, a breadth-first
// search): long runs of shifts, interleaved pushes, unshift into the slack a shift left, a mix past
// the 255-element fold, holes and undefined values, length assignment, splice, indexOf and includes,
// iteration and JSON after shifts, a sort and a reverse, and a copy by slice and by spread.
function main(): void {
  const out: string[] = [];
  const q: number[] = [];
  let sum = 0, drained = 0;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 600; i++) q.push(i + round * 1000);
    while (q.length > 100) { sum += q.shift()!; drained++; }
  }
  out.push(String(q.length), String(sum), String(drained), String(q[0]), String(q[q.length - 1]));
  q.unshift(-1, -2);
  q.unshift(-3);
  out.push(String(q.length), q.slice(0, 5).join(","), String(q.indexOf(2500)), String(q.includes(-3)), String(q.lastIndexOf(2999)));
  for (let i = 0; i < 50; i++) { q.shift(); q.push(i); q.unshift(-i); }
  out.push(String(q.length), q.slice(0, 4).join(","), q.slice(-3).join(","));
  const holes: (number | undefined)[] = [];
  for (let i = 0; i < 40; i++) holes.push(i % 3 === 0 ? undefined : i);
  delete holes[5];
  let seen = 0;
  for (let i = 0; i < 20; i++) { const v = holes.shift(); if (v === undefined) seen++; }
  out.push(String(seen), String(holes.length), String(5 in holes), String(holes.indexOf(undefined)), JSON.stringify(holes.slice(0, 6)));
  const d: string[] = [];
  for (let i = 0; i < 300; i++) d.push("s" + i);
  for (let i = 0; i < 280; i++) d.shift();
  d.length = 10;
  out.push(d.join("|"), String(d.length));
  d.length = 25;
  out.push(String(d.length), String(d[20]), String(20 in d), d.splice(2, 3, "x", "y").join(","), d.slice(0, 6).join(","));
  const r: number[] = [];
  for (let i = 0; i < 100; i++) r.push((i * 37) % 101);
  for (let i = 0; i < 60; i++) r.shift();
  r.sort((a, b) => a - b);
  r.reverse();
  out.push(r.slice(0, 5).join(","), String(r.length), String([...r].length), String(Array.from(r)[r.length - 1]), JSON.stringify(r.slice(-3)));
  let forOf = 0;
  for (const v of r) forOf += v;
  out.push(String(forOf), String(r.reduce((a, b) => a + b, 0)), String(r.map((x) => x * 2).filter((x) => x > 100).length));
  const empty: number[] = [1, 2];
  out.push(String(empty.shift()), String(empty.shift()), String(empty.shift()), String(empty.length), String(empty.unshift(9)), String(empty[0]));
  console.log(out.join("\n"));
}
main();
