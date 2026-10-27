// Numeric locals of generators and async functions whose values must survive a suspension (the frame
// keeps only those; the others are the resume function's own): counters and accumulators updated across
// yields in loops, a double and an integer both live across a yield, a temporary used only between two
// yields, a value read before any write, nested generators delegated with yield*, a generator left early
// by a break (the return path), a for...of with index arithmetic around a yield, char-code arithmetic as a
// lexer does, and an async function awaiting between numeric updates.
function* counters(n: number): Generator<number, number, number | undefined> {
  let total = 0, i = 0, scale = 1.5, unread = 0;
  while (i < n) {
    const step = i * 2 + 1;           // used before the yield only
    const sent = yield step * scale;  // total, i and scale live across
    if (sent !== undefined) total += sent;
    total += step;
    i++;
    scale = scale === 1.5 ? 2.5 : 1.5;
  }
  return total + unread;
}
function* lexer(src: string): Generator<string, number, undefined> {
  let offset = 0, tokens = 0;
  while (offset < src.length) {
    let end = offset;
    while (end < src.length && src.charCodeAt(end) !== 32) end++;
    const word = src.slice(offset, end);
    if (word.length > 0) { yield word; tokens++; }
    offset = end + 1;
  }
  return tokens;
}
function* outer(): Generator<number, void, undefined> {
  let acc = 0;
  for (let k = 0; k < 3; k++) {
    const inner = yield* delegated(k);   // acc live across the delegated yields
    acc += inner + k;
    yield acc;
  }
}
function* delegated(k: number): Generator<number, number, undefined> {
  let s = 0;
  for (let j = 0; j <= k; j++) { s += j * 10; yield s; }
  return s;
}
async function waiter(xs: number[]): Promise<number> {
  let sum = 0, maxv = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i] * 1.25;
    await Promise.resolve();
    sum += v; if (v > maxv) maxv = v;
  }
  return sum + maxv;
}
function main(): void {
  const out: string[] = [];
  const g = counters(4);
  let r = g.next();
  const seen: number[] = [];
  let sendIn = 10;
  while (!r.done) { seen.push(r.value); r = g.next(sendIn); sendIn += 10; }
  out.push(seen.join(","), String(r.value));
  const words: string[] = [];
  const lx = lexer("let  x = 42 ;");
  let lr = lx.next();
  while (!lr.done) { words.push(lr.value); lr = lx.next(); }
  out.push(words.join("|"), String(lr.value));
  out.push([...outer()].join(","));
  const early: number[] = [];
  for (const v of counters(100)) { early.push(v); if (early.length === 3) break; }
  out.push(early.join(","));
  let idx = 0, weighted = 0;
  for (const w of lexer("a bb ccc")) { weighted += w.length * (idx + 1); idx++; }
  out.push(String(weighted), String(idx));
  waiter([1, 2, 3, 4]).then((v) => console.log(out.join("\n") + "\n" + v));
}
main();
