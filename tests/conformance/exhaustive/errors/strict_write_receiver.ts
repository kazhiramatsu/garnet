// Strict-mode property writes on bad receivers (TS/ESM is always strict):
// undefined/null throw "Cannot set properties of ...", primitives throw
// "Cannot create property ..." — catchable TypeErrors with V8's exact messages,
// never a silent ignore. Reads on primitives still box (no throw): n.x is
// undefined, s.length works.
function main(): void {
  const u: any = undefined;
  try { u.a = 1; } catch (e: any) { console.log(e instanceof TypeError, e.message); }
  const nl: any = null;
  try { nl.b = 2; } catch (e: any) { console.log(e instanceof TypeError, e.message); }
  const n: any = 5;
  try { n.c = 3; } catch (e: any) { console.log(e instanceof TypeError, e.message); }
  const s: any = "hi";
  try { s.d = 4; } catch (e: any) { console.log(e instanceof TypeError, e.message); }
  const b: any = true;
  try { b.e = 5; } catch (e: any) { console.log(e instanceof TypeError, e.message); }

  // reads on primitives keep boxing semantics (no throw)
  console.log(n.c, n.toFixed(1), s.length, s.x);
}
main();
