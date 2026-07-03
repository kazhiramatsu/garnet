function main(): void {
  const o: any = {};
  Object.defineProperty(o, "x", { value: 1, writable: false });
  // strict mode: assigning to a non-writable property throws.
  try { o.x = 99; } catch (e) { console.log((e as Error).message); }
  console.log(o.x);          // 1
  Object.defineProperty(o, "y", { value: 10, writable: true });
  o.y = 20;                  // allowed
  console.log(o.y);          // 20
}
main();
