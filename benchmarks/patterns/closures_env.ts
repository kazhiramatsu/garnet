// Nested declarations capturing variables (checker style) and closure values.
function check(items: number[]): number {
  let errors = 0; let depth = 0;
  function report(code: number): void { errors += code; }
  function isRelated(a: number, b: number): boolean { depth++; if (a === b) return true; if ((a & 1) !== (b & 1)) { report(1); return false; } return a < b; }
  const pred = (x: number): boolean => isRelated(x, x + (depth & 3));
  let ok = 0;
  for (let i = 0; i < items.length; i++) { if (isRelated(items[i], items[(i + 1) % items.length])) ok++; if (pred(items[i])) ok++; }
  return ok + errors + depth;
}
function main(): void {
  const items: number[] = []; for (let i = 0; i < 2000; i++) items.push((i * 31) % 101);
  let sum = 0; for (let r = 0; r < 12000; r++) sum += check(items);
  console.log(sum);
}
main();
