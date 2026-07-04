// The user program that motivated ES5 function-constructor support (s319),
// promoted from the repo-root scratch file a.ts. It exercises the combination
// the feature was built for, at TOP LEVEL (no main() — the __module_init path
// for NewDynamic): a plain function called normally, a module binding shadowed
// by a parameter name, an ES5 constructor whose body reads the IMPLICIT `this`
// (no `this` parameter), and the strict receiver guard — `this.prototype` is
// undefined on the fresh instance, so the write throws V8's exact TypeError.
// The original ran these uncaught (process abort, V8-identical stderr); here
// the throws are caught so the harness can compare messages on stdout.
function a(b: number, x: string): any {
  console.log(x, b);
}

let b = {
  "foo": 1,
};

a(1, "foo");

function Foo() {
  this.prototype.a = 1;
}
console.log(b);
let x: any;
try {
  x = new Foo;
} catch (e: any) {
  console.log(e instanceof TypeError, e.message);
}
console.dir(x);
try {
  console.dir(x.a);
} catch (e: any) {
  console.log(e instanceof TypeError, e.message);
}
