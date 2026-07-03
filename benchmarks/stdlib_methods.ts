function main(): void {
  const a = [1, 2, 3, 4, 5];
  const doubled = a.map(x => x * 2);
  const evens = a.filter(x => x % 2 === 0);
  const sum = a.reduce((acc, x) => acc + x, 0);
  console.log(doubled.join(","));        // 2,4,6,8,10
  console.log(evens.length);             // 2
  console.log(sum);                      // 15
  console.log(a.indexOf(3));             // 2
  console.log(a.slice(1, 3).join("-"));  // 2-3
  const s = "Hello World";
  console.log(s.toUpperCase());          // HELLO WORLD
  console.log(s.toLowerCase());          // hello world
  console.log(s.slice(0, 5));            // Hello
  console.log(s.indexOf("World"));       // 6
  console.log(s.split(" ").length);      // 2
  console.log(s.includes("World") ? 1 : 0); // 1
  console.log("ab".repeat(3));           // ababab
  console.log("  hi  ".trim());          // hi
}

main();
