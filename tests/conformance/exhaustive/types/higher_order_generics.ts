function compose<A, B, C>(f: (b: B) => C, g: (a: A) => B): (a: A) => C { return (a) => f(g(a)); }
function pipe<T>(x: T, ...fns: ((x: T) => T)[]): T { return fns.reduce((acc, f) => f(acc), x); }
function curry<A, B, C>(f: (a: A, b: B) => C): (a: A) => (b: B) => C { return (a) => (b) => f(a, b); }
function identity<T>(x: T): T { return x; }
function applyTwice<T>(f: (x: T) => T, x: T): T { return f(f(x)); }

function main(): void {
  const inc = (n: number) => n + 1;
  const double = (n: number) => n * 2;
  const h = compose(double, inc);
  console.log(h(5));                                // (5+1)*2 = 12
  console.log(pipe(3, inc, double, inc));           // ((3+1)*2)+1 = 9
  const add = curry((a: number, b: number) => a + b);
  console.log(add(2)(3));                           // 5
  console.log(identity("x"), identity(42));         // x 42
  console.log(applyTwice(double, 3));               // 12
  const fns = [inc, double];
  console.log(fns.map(f => applyTwice(f, 10)).join(",")); // 12,40
}
main();
