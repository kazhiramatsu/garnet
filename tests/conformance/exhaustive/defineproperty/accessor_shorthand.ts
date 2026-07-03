function main(): void {
  const o: any = { _v: 10 };
  Object.defineProperty(o, "x", {
    get(): number { return this._v; },
    set(v: number) { this._v = v; },
  });
  console.log(o.x);     // 10
  o.x = 25;
  console.log(o.x);     // 25
  console.log(o._v);    // 25
}
main();
