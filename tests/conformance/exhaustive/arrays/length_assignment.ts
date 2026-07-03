function main(): void {
  // truncate / extend with holes
  const a: any[] = [1, 2, 3, 4, 5];
  a.length = 3; console.log(a.join(","), a.length);
  a.length = 5; console.log(a.length, a[3], a[4], a.join(","));
  a.length = 0; console.log(a.length, a.join(","));
  a.push(9); console.log(a.join(","), a.length);
  // invalid lengths throw RangeError
  for (const v of [-1, 1.5, NaN, 4294967296, Infinity, -0.5]) {
    try { ([1, 2] as any).length = v; console.log("no-throw"); }
    catch (e) { console.log(e instanceof RangeError); }
  }
}
main();
