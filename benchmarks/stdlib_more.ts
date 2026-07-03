function main(): void {
  const a = [5, 2, 8, 1, 9, 3];
  console.log(a.find(x => x > 4));          // 5
  console.log(a.findIndex(x => x > 4));     // 0
  console.log(a.some(x => x > 8) ? 1 : 0);  // 1
  console.log(a.every(x => x > 0) ? 1 : 0); // 1
  console.log(a.at(-1));                     // 3
  console.log(a.lastIndexOf(8));             // 2
  const sorted = [3, 1, 2].sort();
  console.log(sorted.join(","));             // 1,2,3
  const desc = [1, 2, 3].sort((x, y) => y - x);
  console.log(desc.join(","));               // 3,2,1
  const r = [1, 2, 3].reverse();
  console.log(r.join(","));                  // 3,2,1
  const b = [1, 2, 3];
  console.log(b.shift());                    // 1
  console.log(b.unshift(0));                 // 3 (new length)
  console.log(b.join(","));                  // 0,2,3
  const s = "Hello World";
  console.log(s.startsWith("Hello") ? 1 : 0); // 1
  console.log(s.endsWith("World") ? 1 : 0);   // 1
  console.log("5".padStart(3, "0"));          // 005
  console.log("5".padEnd(3, "x"));            // 5xx
  console.log("a-b-c".replace("-", "+"));     // a+b-c
  console.log("a-b-c".replaceAll("-", "+"));  // a+b+c
  console.log(s.at(-1));                      // d
}

main();
