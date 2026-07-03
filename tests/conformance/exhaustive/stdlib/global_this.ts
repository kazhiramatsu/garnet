var ModuleVar = 1;
let ModuleLet = 2;
function ModuleFn(): number {
  return 3;
}

function main(): void {
  console.log(Array === globalThis.Array);
  console.log(Object === globalThis.Object);
  console.log(Promise === globalThis.Promise);
  console.log(Map === globalThis.Map);
  console.log(console === globalThis.console);
  console.log(Math === globalThis.Math);

  {
    const Array = 1;
    console.log(Array);
  }
  console.log(Array === globalThis.Array);

  function f(): number {
    const Promise = 2;
    return Promise;
  }
  console.log(f());
  console.log(Promise === globalThis.Promise);

  console.log(Array.isArray === globalThis.Array.isArray);
  console.log(Math.sqrt === globalThis.Math.sqrt);
  console.log(globalThis.Array.isArray([1, 2]));
  console.log(globalThis.Math.sqrt(9));
  console.log(globalThis.Object.keys({ a: 1 }).join(","));
  console.log(globalThis.JSON.stringify({ a: 1 }));
  console.log(parseInt === globalThis.parseInt, globalThis.parseInt("42", 10));
  console.log("ModuleVar" in globalThis);
  console.log("ModuleLet" in globalThis);
  console.log("ModuleFn" in globalThis);
  console.log(ModuleFn());
}

main();
