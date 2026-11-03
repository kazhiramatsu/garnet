// Array.prototype.toLocaleString is each element's own method (it was join, silently: 1234.5 printed without its grouping,
// an object's toLocaleString was not called), and a pattern known only at run time reaches match and search.
function choose(): string { return "b"; }
function main(): void {
  console.log([3, 1, 2].toLocaleString());
  console.log([1234.5, "x", null, undefined, [7, 8], { toLocaleString() { return "o"; } }, 1e21, -0, NaN].toLocaleString());
  console.log(([] as number[]).toLocaleString(), [null].toLocaleString(), [[]].toLocaleString());
  console.log([new Date(0).getTime()].toLocaleString());
  console.log(([1234.5, 2] as any).toLocaleString("en-US", { minimumFractionDigits: 2 }));
  const calls: unknown[][] = [];
  ([{ toLocaleString(...a: unknown[]) { calls.push(a); return "x"; } }] as any).toLocaleString("en-US", { a: 1 }, "dropped");
  console.log(calls.length, calls[0][0], calls[0].length >= 2);
  try { console.log([{ toLocaleString: 1 }].toLocaleString()); } catch (e) { console.log((e as Error).name); }
  try { console.log([{ toLocaleString() { throw new RangeError("r"); } }].toLocaleString()); } catch (e) { console.log((e as Error).name); }
  console.log([{ toLocaleString() { return 12; } }].toLocaleString());
  const cyc: any[] = [1234.5]; cyc.push(cyc); console.log(cyc.toLocaleString());
  const f = [1234.5].toLocaleString; console.log(typeof f, f.name, f.length, f.call([9999]));
  console.log("abc".match(choose()), "abc".search(choose()));
  console.log("a.c".match("."), "a.c".search("."));
  const bad = "(";
  try { "abc".match(bad); } catch (e) { console.log((e as Error).name); }
  try { "abc".search(bad); } catch (e) { console.log((e as Error).name); }
}
main();
