// Computed class member names with string/numeric LITERAL keys are semantically
// identical to normally-named members and must lower to the same vtable slots /
// field keys (and stay devirtualizable).
class Widget {
  ["label"] = "w";              // computed literal field
  [42] = 7;                     // numeric computed field -> key "42"
  _v = 0;
  ["area"](n: number): number { // computed method
    return n * n;
  }
  get ["v"](): number { return this._v; }      // computed getter
  set ["v"](x: number) { this._v = x; }         // computed setter
  static ["kind"] = "static-w";  // computed static field
  static ["make"](): number { return 99; }      // computed static method
}

function main(): void {
  const w = new Widget();
  console.log(w.label);          // w
  console.log((w as any)[42]);   // 7
  console.log(w.area(5));        // 25
  w.v = 11;
  console.log(w.v);              // 11 (setter then getter fire)
  console.log(Widget.kind);      // static-w
  console.log(Widget.make());    // 99

  // devirt hot path: a stable class with a computed-literal method, called over
  // a homogeneous array, must resolve and sum correctly.
  const ws = [new Widget(), new Widget(), new Widget()];
  let s = 0;
  for (const x of ws) s += x.area(2);
  console.log(s);                // 12
}

main();
