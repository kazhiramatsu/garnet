function main(): void {
  // descriptor stored in a variable (non-literal)
  const o: any = {};
  const d = { value: 42, enumerable: true };
  Object.defineProperty(o, "x", d);
  console.log(o.x, Object.keys(o).join(","));    // 42 x

  // attribute value from a variable; strict-mode write to non-writable throws.
  const w = false;
  const o2: any = {};
  Object.defineProperty(o2, "y", { value: 1, writable: w });
  try { o2.y = 99; } catch (e) { console.log((e as Error).message); }
  console.log(o2.y);                              // 1

  // empty descriptor: value undefined, all attrs false
  const o3: any = {};
  Object.defineProperty(o3, "z", {});
  console.log("z" in o3, o3.z, Object.keys(o3).length); // true undefined 0

  // dynamic defineProperties map
  const o4: any = {};
  const descs = { a: { value: 1, enumerable: true }, b: { value: 2 } };
  Object.defineProperties(o4, descs);
  console.log(o4.a, o4.b, Object.keys(o4).join(",")); // 1 2 a
}
main();
