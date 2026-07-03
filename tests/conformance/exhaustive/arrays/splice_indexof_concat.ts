// Array.splice (in-place remove/insert), indexOf/lastIndexOf fromIndex, and
// variadic concat (array args spread, non-array args appended).
function main(): void {
  // splice: replace, delete-to-end, insert-only, negative start, overflow count.
  const a = [1, 2, 3, 4, 5];
  const r = a.splice(1, 2, 9, 8);
  console.log(a.join(","), r.join(","));        // 1,9,8,4,5 2,3
  const b = [1, 2, 3, 4, 5];
  console.log(b.splice(2).join(","), b.join(",")); // 3,4,5 1,2
  const c = [1, 2, 3];
  c.splice(1, 0, 9, 8);
  console.log(c.join(","));                      // 1,9,8,2,3
  const d = [1, 2, 3, 4, 5];
  console.log(d.splice(-2, 1).join(","), d.join(",")); // 4 1,2,3,5

  // indexOf / lastIndexOf with a fromIndex.
  console.log([1, 2, 3, 2, 1].indexOf(2, 2));     // 3
  console.log([1, 2, 3, 2, 1].indexOf(2, -2));    // 3
  console.log([1, 2, 3, 2, 1].lastIndexOf(2, 1)); // 1
  console.log("ababab".indexOf("a", 1));          // 2
  console.log("ababab".lastIndexOf("a", 3));      // 2

  // concat: array args are spread, non-array args appended.
  console.log([1].concat([2, 3], 4, [5]).join(",")); // 1,2,3,4,5
  console.log([1, 2].concat(3, 4, 5).join(","));     // 1,2,3,4,5
  const e = [1, 2];
  console.log(e.concat().join(","), e.concat() === e); // 1,2 false
}

main();
