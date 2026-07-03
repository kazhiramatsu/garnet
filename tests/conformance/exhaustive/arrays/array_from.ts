function* gen(): Generator<number> { yield 1; yield 2; yield 3; }

function main(): void {
  // From an array (a shallow copy).
  console.log(Array.from([1, 2, 3]).join(","));            // 1,2,3
  console.log(Array.from([]).length);                       // 0

  // From an array with a map function (element, index).
  console.log(Array.from([1, 2, 3], (x) => x * 2).join(",")); // 2,4,6
  console.log(Array.from(["a", "b", "c"], (v, i) => i + ":" + v).join(",")); // 0:a,1:b,2:c

  // From a Set (dedups, preserves insertion order).
  console.log(Array.from(new Set([3, 1, 2, 2, 3])).join(",")); // 3,1,2

  // From a Map (yields [key, value] pairs).
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  console.log(Array.from(m).map((e) => e[0] + e[1]).join(",")); // a1,b2

  // From a string (uses the string iterator, so surrogate pairs stay together).
  console.log(Array.from("abc").join("-"));                 // a-b-c
  console.log(Array.from("A😀B").map((ch) => ch + ":" + ch.length).join("|")); // A:1|😀:2|B:1

  // From a generator.
  console.log(Array.from(gen()).join(","));                 // 1,2,3
  console.log(Array.from(gen(), (x) => x * 10).join(","));  // 10,20,30

  // From an array-like { length } with a map function (the classic range idiom).
  console.log(Array.from({ length: 5 }, (_, i) => i * i).join(",")); // 0,1,4,9,16
  console.log(Array.from({ length: 3 }, (_, i) => i).join(","));     // 0,1,2
}
main();
