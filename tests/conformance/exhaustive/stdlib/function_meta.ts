// Function.prototype.length (arity) and Function.prototype.name on a boxed
// function value. length = leading params with no default, before the first
// defaulted/rest param (TS optional `?` is erased, so it still counts). name =
// the declared name, or the JS-inferred name from a binding for an anonymous
// arrow / function expression.
function greet(name: string, greeting = "hi") { return greeting + name; }
function noargs() { return 1; }
function three(a: number, b: number, c: number) { return a + b + c; }
function withRest(a: number, ...rest: number[]) { return a; }
function withOptional(a: number, b?: number) { return a; }

function main(): void {
  // .name on named declarations (as a value and direct)
  const g = greet;
  console.log(g.name, greet.name);                 // greet greet

  // .length: required params before the first default
  console.log(three.length, greet.length, noargs.length); // 3 1 0
  console.log(withRest.length, withOptional.length);       // 1 2  (optional counts)

  // both at once
  console.log(`${greet.name}/${greet.length}`);    // greet/1

  // arrow / function expression name inference from a binding
  const myArrow = () => 5;
  console.log(myArrow.name);                         // myArrow
  const named = function inner() { return 1; };
  console.log(named.name);                           // inner
  const obj = { handler: () => 0 };
  console.log(typeof obj.handler);                   // function (handler boxed)

  // truly anonymous -> name ""
  console.log([1].map(() => 2)[0], ([1, 2].filter(x => x > 0)).length); // 2 2

  // closure keeps its name and arity
  function make() { return function counter(a: number, b: number) { return a + b; }; }
  const c = make();
  console.log(c.name, c.length);                     // counter 2

  // passed as callback / used in expressions
  console.log([three, greet, noargs].map(f => f.length).join(","));  // 3,1,0
  console.log([three, greet].map(f => f.name).join(","));            // three,greet
  console.log(noargs.length + three.length);                         // 3

  // direct calls unchanged (regression)
  console.log(greet("X"), three(1, 2, 3));           // hiX 6
}

main();
