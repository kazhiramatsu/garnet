function main(): void {
  const o: any = {
    _v: 0,
    get x(): number { return this._v; },
    set x(val: number) { this._v = val; },
  };
  console.log(o.x);                        // 0
  o.x = 7;
  console.log(o.x);                        // 7
  console.log(o._v);                       // 7
  console.log(Object.keys(o).join(","));   // _v,x  (accessor is enumerable)
  // getter-only
  const o2: any = { get y(): number { return 99; } };
  console.log(o2.y);                       // 99
}
main();
