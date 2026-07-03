function main(): void {
  // comma
  let a = 0; const b = (a = 1, a + 5); console.log(b);   // 6
  // delete
  const o1: any = {x: 1, y: 2}; delete o1.x; console.log("x" in o1 ? 1 : 0);  // 0
  // dynamic in
  const k: string = "y"; console.log(k in o1 ? 1 : 0);   // 1
  // rest in array destructure
  const [first, ...tail] = [10, 20, 30]; console.log(first + tail.length);  // 12
  // rest in object destructure
  const obj = {p: 1, q: 2, r: 3}; const {p, ...others} = obj; console.log(p + Object.keys(others).length);  // 3
  // for-in + dynamic o[k]
  const m: any = {a: 1, b: 2, c: 3}; let total = 0;
  for (const key in m) total = total + m[key]; console.log(total);  // 6
  // o[k] = v dynamic store
  const dst: any = {}; const fld: string = "z"; dst[fld] = 99; console.log(dst.z);  // 99
  // labeled break
  let c = 0; loop: for (let i = 0; i < 5; i++) { if (i === 3) break loop; c = c + i; } console.log(c);  // 3
}

main();
