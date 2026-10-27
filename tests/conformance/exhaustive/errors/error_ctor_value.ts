// The Error constructors as first-class values: `new E(msg)` and `E(msg)` both make an error of the kind,
// instanceof, name and message, the prototype property and its constructor, identity across reads, the
// TypeError value's chain to Error, Reflect.construct over the value, and a throw of a constructed value.
function main(): void {
  const out: string[] = [];
  const E: any = Error, TE: any = TypeError, RE: any = RangeError;
  const a = new E("one"), b = E("two");
  out.push(String(a instanceof Error), a.message, a.name, String(b instanceof Error), b.message);
  const t = new TE("three");
  out.push(String(t instanceof TypeError), String(t instanceof Error), t.name, String(TE.prototype === TypeError.prototype), String(Object.getPrototypeOf(TE) === Error));
  out.push(String(E === Error), String(E.prototype.constructor === E), E.name, String(E.length), String(new RE("r").name));
  const made = Reflect.construct(E, ["four"]) as Error;
  out.push(String(made instanceof Error), made.message);
  try { throw new TE("thrown"); } catch (err) { out.push(err instanceof TypeError ? "caught " + (err as Error).message : "wrong"); }
  console.log(out.join("\n"));
}
main();
