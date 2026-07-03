// The Array constructor: a single numeric argument is the LENGTH (holes are
// undefined, not 0); any other argument list is the element list.
function main(): void {
  console.log(new Array(3).length);                 // 3
  console.log(new Array(3).fill(0).join(","));       // 0,0,0
  console.log(new Array(1, 2, 3).join(","));         // 1,2,3
  console.log(new Array("x").length, new Array("x")[0]); // 1 x

  const e = new Array<number>();
  e.push(5);
  console.log(e.length, e[0]);                       // 1 5

  // holes read back as undefined, NOT 0.
  const h = new Array(2);
  console.log(String(h[0]), h.length);               // undefined 2

  console.log(new Array(4).fill(0).map((_v, i) => i * i).join(",")); // 0,1,4,9
}

main();
