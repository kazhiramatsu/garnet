// A bare `Function.prototype` used as a first-class value. In JS, Function.prototype
// is itself a callable no-op FUNCTION: typeof is "function", calling it returns
// undefined, its length is 0 and its name is "". It has stable identity, and its
// own call/apply/bind are still usable as method values (§90). V8 is the oracle.
//
// (console.log(Function.prototype) / String(Function.prototype) render specially in
// Node — we avoid printing the object directly and assert the observable scalar
// facts instead. Object.getPrototypeOf of a function is a separate pre-existing gap
// and is not exercised here.)

function main(): void {
  const p = Function.prototype;

  // Function.prototype is a callable no-op function.
  console.log(typeof p);                        // function
  console.log(typeof Function.prototype);       // function
  console.log((p as () => unknown)());          // undefined (no-op)
  console.log((p as (...a: number[]) => unknown)(1, 2, 3)); // undefined
  console.log((Function.prototype as { length: number }).length); // 0
  console.log(JSON.stringify((Function.prototype as { name: string }).name)); // ""

  // stable identity
  console.log(Function.prototype === Function.prototype); // true
  console.log(p === Function.prototype);                  // true

  // its own call/apply/bind are still first-class method values (§90 #129b)
  console.log(typeof Function.prototype.call);   // function
  console.log(typeof Function.prototype.apply);  // function
  console.log(typeof Function.prototype.bind);   // function
  // method-borrow via the bare-proto path: call.call(fn, thisArg, ...args)
  console.log(Function.prototype.call.call((a: number, b: number) => a + b, null, 2, 3)); // 5

  // regression: ordinary functions still behave normally (every function's proto is
  // the FUNC-kind Function.prototype now — make sure nothing about that broke).
  function add(a: number, b: number, c: number): number { return a + b + c; }
  console.log(typeof add, add.length, add.name); // function 3 add
  console.log(add.call(null, 1, 2, 3));          // 6
  console.log(add.bind(null, 10)(20, 30));       // 60
  console.log(add.apply(null, [4, 5, 6]));       // 15
  const arrow = (x: number) => x * 2;
  console.log(typeof arrow, arrow(21));          // function 42
}

main();
