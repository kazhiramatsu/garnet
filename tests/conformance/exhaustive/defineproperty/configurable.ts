function main(): void {
  const o: any = {};
  Object.defineProperty(o, "x", { value: 1, configurable: false });
  // strict mode: deleting a non-configurable property throws.
  try { delete o.x; } catch (e) { console.log((e as Error).message); }
  console.log(o.x);               // 1
  Object.defineProperty(o, "y", { value: 2, configurable: true });
  console.log(delete o.y, o.y);   // true undefined
}
main();
