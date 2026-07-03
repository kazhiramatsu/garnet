// Array.prototype.with throws a RangeError when the (resolved) index is out of
// bounds, both for too-large positive and too-negative indices. We catch and check
// `e.name` ("RangeError") and that `e.message` is a string — the exact message text
// isn't asserted (it differs from V8's wording). The throw is catchable and control
// continues normally afterward.

function main(): void {
  const a = [1, 2, 3];

  // positive out of range
  try {
    a.with(99, 0);
    console.log("no-throw");
  } catch (e: any) {
    console.log(e.name + ":" + typeof e.message); // RangeError:string
  }

  // negative out of range (resolves to < 0)
  try {
    a.with(-99, 0);
    console.log("no-throw");
  } catch (e: any) {
    console.log(e.name); // RangeError
  }

  // index === length is out of range (valid indices are 0..length-1)
  try {
    a.with(3, 0);
    console.log("no-throw");
  } catch (e: any) {
    console.log(e.name); // RangeError
  }

  // in-range writes do NOT throw; the receiver is unchanged.
  console.log(JSON.stringify(a.with(2, 7))); // [1,2,7]
  console.log(JSON.stringify(a));            // unchanged [1,2,3]

  // the throw is catchable and execution continues after the handler
  let after = 0;
  try {
    a.with(50, 0);
  } catch {
    after = 1;
  }
  console.log(after); // 1
}

main();
