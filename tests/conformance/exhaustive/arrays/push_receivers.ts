// Element stores and pushes on arrays with an integrity level: frozen
// (every write throws), sealed and non-extensible (a write to an element the
// array has succeeds, a new element throws), the lengths afterwards, the
// integrity predicates, a bracket-named push through `any`, and a store
// into a hole of a sealed array.
function attempt(label: string, f: () => unknown, out: unknown[]) {
  try { out.push(label, f()); } catch (e) { out.push(label, (e as Error).constructor.name); }
}
function main() {
  const out: unknown[] = [];
  const frozen = Object.freeze([1, 2, 3]) as number[];
  attempt("frozen push", () => frozen.push(4), out);
  attempt("frozen store", () => { frozen[0] = 9; return frozen[0]; }, out);
  attempt("frozen add", () => { frozen[3] = 9; return frozen.length; }, out);
  const sealed = Object.seal([1, 2, 3]) as number[];
  attempt("sealed push", () => sealed.push(4), out);
  attempt("sealed store", () => { sealed[0] = 9; return sealed[0]; }, out);
  attempt("sealed add", () => { sealed[3] = 9; return sealed.length; }, out);
  attempt("sealed far add", () => { sealed[100] = 9; return sealed.length; }, out);
  const holes = Object.seal([1, , 3]) as number[];
  attempt("sealed hole store", () => { holes[1] = 2; return holes.length; }, out);
  attempt("sealed hole read", () => holes[1], out);
  const nonext = Object.preventExtensions([1, 2]) as number[];
  attempt("nonext push", () => nonext.push(3), out);
  attempt("nonext store", () => { nonext[1] = 7; return nonext[1]; }, out);
  attempt("nonext add", () => { nonext[2] = 7; return nonext.length; }, out);
  attempt("nonext two pushes", () => nonext.push(5, 6), out);
  out.push(frozen.length, sealed.length, nonext.length, holes.length);
  out.push(Object.isFrozen(frozen), Object.isSealed(sealed), Object.isExtensible(nonext), Object.isSealed(nonext), Object.isFrozen(sealed));
  const plain = [1, 2];
  attempt("plain add", () => { plain[5] = 6; return plain.length; }, out);
  attempt("plain push", () => plain.push(7), out);
  const anyArr = [] as any;
  anyArr.push(1); anyArr["push"](2); const k = "push"; anyArr[k](3);
  out.push(anyArr.length, anyArr[2]);
  const sealedAny = Object.seal([1]) as any;
  attempt("sealed any push", () => sealedAny.push(2), out);
  attempt("sealed any bracket push", () => sealedAny["push"](2), out);
  console.log(JSON.stringify(out));
}
main();
