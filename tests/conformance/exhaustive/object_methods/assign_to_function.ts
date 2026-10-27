// Object.assign with a function as the target: the properties land on the function (a callable namespace),
// the function stays callable and keeps its name and length, the result is the target, and a spread of a
// function source copies its own enumerable properties; null and undefined targets throw.
function F(this: unknown, v: number): number { return v + 1; }
function main(): void {
  const out: string[] = [];
  const B = Object.assign(F, { from(x: number): number { return x * 2; }, tag: "t", count: 3 });
  out.push(typeof B, String(B === F), String(B(1)), String(B.from(2)), B.tag, String(B.count), B.name, String(B.length), Object.keys(B).sort().join(","));
  const more = Object.assign(B, { count: 4 }, { extra: true });
  out.push(String(more.count), String((more as { extra: boolean }).extra), Object.keys(F).sort().join(","));
  const copy = { ...(B as unknown as Record<string, unknown>) };
  out.push(Object.keys(copy).sort().join(","), String(copy.tag));
  let threw = 0;
  try { Object.assign(null as unknown as object, { a: 1 }); } catch (e) { threw += e instanceof TypeError ? 1 : 0; }
  try { Object.assign(undefined as unknown as object, { a: 1 }); } catch (e) { threw += e instanceof TypeError ? 1 : 0; }
  out.push(String(threw));
  console.log(out.join("\n"));
}
main();
