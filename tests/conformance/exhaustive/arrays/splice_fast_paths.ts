// splice whose result is discarded: the single-element insert and the general
// form must behave exactly as the general splice (indices, holes, growth,
// frozen receivers), and the result-using forms are unchanged.
function fill(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(i); return a; }
function main(): void {
  // single insert at every kind of index, into inline and heap-backed arrays
  for (const len of [0, 1, 3, 4, 5, 17]) {
    const out: string[] = [];
    for (const at of [0, 1, 2, 4, -1, -3, -100, 100, 1.5, NaN]) {
      const a = fill(len); a.splice(at, 0, 1000 + at);
      out.push(a.join("."));
    }
    console.log(len + ":" + out.join("|"));
  }
  // repeated sorted insertion (the checker's typeSet pattern) with GC pressure
  const sorted: { id: number }[] = [];
  for (let i = 0; i < 20000; i++) {
    const v = { id: (i * 7919) % 20011 };
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].id < v.id) lo = mid + 1; else hi = mid; }
    sorted.splice(lo, 0, v);
    if ((i & 4095) === 0) { let junk = 0; for (let j = 0; j < 20000; j++) junk += [j].length; if (junk < 0) console.log(junk); }
  }
  let ok = 0; for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].id <= sorted[i].id) ok++;
  console.log(sorted.length, ok, sorted[0].id, sorted[sorted.length - 1].id);
  // the general discarded forms: delete, replace, insert several, delete to end
  const b = fill(8); b.splice(2, 3); console.log(b.join(","));
  const c = fill(8); c.splice(1, 2, 90, 91, 92); console.log(c.join(","));
  const d = fill(8); d.splice(-2, 1, 7); console.log(d.join(","));
  const e = fill(8); e.splice(3); console.log(e.join(","));
  const f = fill(8); f.splice(0, 0, ...[1, 2]); console.log(f.join(","));
  // holes survive and shift
  const h: (number | undefined)[] = [1, , 3]; h.splice(1, 0, 9); console.log(h.length, 1 in h, 2 in h, h.join(","));
  const h2: (number | undefined)[] = [1, , 3]; h2.splice(0, 1); console.log(h2.length, 0 in h2, h2.join(","));
  // result-using forms are untouched
  const g = fill(6); const removed = g.splice(1, 2, 50); console.log(removed.join(","), g.join(","));
  const g2 = fill(6); console.log(g2.splice(4, 0, 77).length, g2.join(","));
  // frozen receiver: strict code throws; a caught error leaves the array intact
  const fr = Object.freeze([1, 2, 3]) as unknown as number[];
  try { fr.splice(1, 0, 9); console.log("frozen-noop", fr.join(",")); } catch (err) { console.log("frozen-throw", fr.join(",")); }
  // a Uint16-like fixed storage array (typed element storage) takes the coercing path
  const words: number[] = []; for (let i = 0; i < 4; i++) words.push(i * 1000);
  words.splice(2, 0, 70000); console.log(words.join(","));
}
main();
