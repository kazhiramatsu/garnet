function main(): void {
  const root = globalThis as any;

  console.log(globalThis === root.globalThis);

  root.__edgeValue = 42;
  console.log(root.__edgeValue);
  console.log("__edgeValue" in globalThis);

  {
    const globalThis = 7;
    console.log(globalThis);
  }
  console.log((globalThis as any).Array === root.Array);

  {
    let Array = 7;
    const Promise = 8;
    console.log(Array);
    console.log(Promise);
    console.log(root.Array === Array);
    console.log(root.Promise === Promise);
  }

  console.log(Object.assign === root.Object.assign);
  console.log(Promise.resolve === root.Promise.resolve);
  console.log(Symbol.for === root.Symbol.for);
  console.log(Date.now === root.Date.now);

  console.log(Array.prototype === root.Array.prototype);
  console.log(Object.prototype === root.Object.prototype);
  console.log(Function.prototype === root.Function.prototype);

  console.log(typeof Object.prototype);
  console.log(Object.prototype.constructor === Object);

  const savedParseInt = root.parseInt;
  root.parseInt = function(_s: any, _radix?: any): number { return 77; };
  console.log(parseInt("10", 10));
  root.parseInt = savedParseInt;

  const savedArray = root.Array;
  root.Array = function(_a: any, _b: any): string { return "custom-array"; };
  console.log(Array(1, 2));
  root.Array = savedArray;

  const savedSqrt = Math.sqrt;
  (Math as any).sqrt = function(_x: any): number { return 66; };
  console.log(Math.sqrt(4));
  (Math as any).sqrt = savedSqrt;

  const savedAbs = Math.abs;
  Object.defineProperty(root.Math, "abs", {
    value: function(_x: any): number { return 88; },
    writable: true,
    configurable: true,
  });
  console.log(Math.abs(-5));
  root.Math.abs = savedAbs;

  const savedParseFloat = root.parseFloat;
  Object.assign(root, {
    parseFloat: function(_s: any): number { return 12; },
  });
  console.log(parseFloat("3.5"));
  root.parseFloat = savedParseFloat;

  const savedFloor = Math.floor;
  Object.defineProperties(root.Math, {
    floor: {
      value: function(_x: any): number { return 44; },
      writable: true,
      configurable: true,
    },
  });
  console.log(Math.floor(1.2));
  root.Math.floor = savedFloor;

  const savedIsFinite = root.isFinite;
  const dynGlobalKey = "isFinite";
  root[dynGlobalKey] = function(_x: any): boolean { return false; };
  console.log(isFinite(1));
  root.isFinite = savedIsFinite;

  const savedCeil = Math.ceil;
  const dynMathKey = "ceil";
  root.Math[dynMathKey] = function(_x: any): number { return 55; };
  console.log(Math.ceil(1.2));
  root.Math.ceil = savedCeil;

  let assignedRoot: any;
  assignedRoot = globalThis;
  const savedAssignedParseInt = root.parseInt;
  assignedRoot.parseInt = function(_s: any): number { return 101; };
  console.log(parseInt("10", 10));
  root.parseInt = savedAssignedParseInt;

  let assignedMath: any;
  assignedMath = Math;
  const savedAssignedSqrt = Math.sqrt;
  assignedMath.sqrt = function(_x: any): number { return 102; };
  console.log(Math.sqrt(4));
  Math.sqrt = savedAssignedSqrt;

  const defineGlobalKey = "parseInt";
  const savedDefineParseInt = root.parseInt;
  Object.defineProperty(globalThis, defineGlobalKey, {
    value: function(_s: any): number { return 103; },
    writable: true,
    configurable: true,
  });
  console.log(parseInt("10", 10));
  root.parseInt = savedDefineParseInt;

  const defineMathKey = "sqrt";
  const savedDefineSqrt = Math.sqrt;
  Object.defineProperty(Math, defineMathKey, {
    value: function(_x: any): number { return 104; },
    writable: true,
    configurable: true,
  });
  console.log(Math.sqrt(4));
  Math.sqrt = savedDefineSqrt;

  const assignComputedGlobalKey = "parseFloat";
  const savedAssignComputedParseFloat = root.parseFloat;
  Object.assign(globalThis, {
    [assignComputedGlobalKey]: function(_s: any): number { return 105; },
  });
  console.log(parseFloat("1.5"));
  root.parseFloat = savedAssignComputedParseFloat;

  const definePropertiesComputedMathKey = "floor";
  const savedDefinePropertiesFloor = Math.floor;
  Object.defineProperties(Math, {
    [definePropertiesComputedMathKey]: {
      value: function(_x: any): number { return 106; },
      writable: true,
      configurable: true,
    },
  });
  console.log(Math.floor(1.2));
  Math.floor = savedDefinePropertiesFloor;

  const savedLog = console.log;
  root.console.log = function(a: any, b: any): void {
    root.__edgeConsole = String(a) + ":" + String(b);
  };
  console.log("mutated", 5);
  savedLog(root.__edgeConsole);
  root.console.log = savedLog;
}

main();
