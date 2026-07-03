function risky(x: number): number { if (x < 0) throw "negative"; return x * 2; }
function main(): void {
  // basic catch
  try { console.log(risky(5)); } catch (e) { console.log("caught"); }   // 10
  // catch a throw
  try { console.log(risky(-1)); } catch (e) { console.log("caught: " + e); } // caught: negative
  // catch with value
  try { throw 42; } catch (e) { console.log(e); }   // 42
  // nested try
  try { try { throw "inner"; } catch (e) { console.log("inner: " + e); throw "rethrown"; } }
  catch (e) { console.log("outer: " + e); }   // inner: inner, outer: rethrown
  // finally on normal path
  try { console.log("try"); } finally { console.log("finally"); }   // try, finally
  console.log("done");
}

main();
