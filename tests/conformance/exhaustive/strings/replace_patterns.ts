// Array(...) called without `new`, and string replace's $-patterns
// ($$ -> $, $& -> match, $` -> prefix, $' -> suffix).
function main(): void {
  console.log(Array(3).length);                  // 3
  console.log(Array(3).fill(0).map((_v, i) => i).join(",")); // 0,1,2
  console.log(Array(1, 2, 3).join(","));          // 1,2,3
  console.log(Array("x").length, Array("x")[0]);  // 1 x

  console.log("hello".replace("l", "[$&]"));      // he[l]lo
  console.log("price".replace("price", "$$5"));   // $5
  console.log("abcde".replace("cd", "<$`|$'>"));  // ab<ab|e>e
  console.log("a.b.c".replaceAll(".", "[$&]"));   // a[.]b[.]c
  console.log("aaa".replace("a", "b"));           // baa
  console.log("hello world".replace("world", "there")); // hello there

  // empty pattern matches at index 0 (replace) / between every char (replaceAll).
  console.log("abc".replace("", "X"));            // Xabc
  console.log("abc".replaceAll("", "X"));         // XaXbXcX
  console.log("".replaceAll("", "X"));            // X
}

main();
