// A class instance frozen through `Object` taken as a value (a call the
// compiler cannot resolve statically): the typed stores still throw, and a
// program that freezes only literals and arrays leaves class instances
// writable (its instances can never be frozen).
class Tok { kind = 0; text = ""; set(k: number, t: string): void { this.kind = k; this.text = t; } }
function main(): void {
  const O: any = Object;
  const n = new Tok();
  n.set(1, "a");
  O.freeze(n);
  const out: string[] = [];
  try { n.kind = 2; out.push("no-throw"); } catch (e) { out.push((e as Error).message); }
  try { n.set(3, "b"); out.push("no-throw"); } catch (e) { out.push((e as Error).message); }
  out.push(String(n.kind), n.text, String(O.isFrozen(n)));
  const literal = Object.freeze({ a: 1 });
  const arr = Object.freeze([1, 2]);
  try { (literal as any).a = 2; out.push("no-throw"); } catch (e) { out.push((e as Error).message); }
  try { (arr as any).push(3); out.push("no-throw"); } catch (e) { out.push((e as Error).message); }
  const m = new Tok(); m.set(5, "c"); m.kind = 6;
  out.push(String(m.kind), String(literal.a), String(arr.length));
  console.log(out.join(" | "));
}
main();
