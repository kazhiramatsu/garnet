// `.toString()` / `.valueOf()` on a receiver the types call a string but that is an object (a String
// wrapper, an object a cast called a string: hono's `(node as string).toString()` on a JSX node): the
// receiver's own method, as V8's dynamic call; a plain object's are Object.prototype's; null is a
// TypeError (docs/jsx_react_ssr_design.md "Built").
class Node { toString(): string { return "node"; } }
function main(): void {
  const n = new Node();
  const s = n as unknown as string;
  console.log(s.toString(), (s.valueOf() as unknown) === n, `${s}`, s + "!");
  const w = new String("wrap") as unknown as string;
  console.log(w.toString(), w.valueOf(), typeof w.valueOf(), typeof w);
  const o = {} as unknown as string;
  console.log(o.toString(), typeof o.valueOf());
  const plain = "str";
  console.log(plain.toString(), plain.valueOf());
  try { (null as unknown as string).toString(); console.log("no throw"); } catch (e) { console.log("TypeError", e instanceof TypeError); }
  try { (undefined as unknown as string).valueOf(); console.log("no throw"); } catch (e) { console.log("TypeError", e instanceof TypeError); }
}
main();
