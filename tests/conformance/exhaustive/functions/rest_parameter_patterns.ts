// A rest parameter may be a pattern: it binds from the array of the surplus arguments, with the other
// parameters, in every kind of function. A generator's and an async function's rest parameter is an array
// (it was the next argument, silently).
function f(...{ length, 0: first }: any) { return [length, first]; }
console.log(f(1, 2, 3), f());
function g(...[a, b = 5, ...r]: any[]) { return [a, b, r]; }
console.log(g(1), g(1, 2, 3, 4));
const h = (...[x]: any[]) => x;
console.log(h(9), h());
function* gen(...[a]: any[]) { yield a; }
console.log(gen(1).next().value);
async function af(...[a]: any[]) { return a; }
af(2).then(console.log);
class K { m(p: number, ...[q]: any[]) { return p + q; } }
console.log(new K().m(1, 2));
function later(a: number, ...[b = a + 1]: any[]) { return [a, b]; }
console.log(later(1), later(1, 7));
function captured(...[n]: any[]) { return () => n * 2; }
console.log(captured(4)());

function* plainGen(a: number, ...r: number[]) { yield a; yield r.length; yield r[1]; }
console.log([...plainGen(1, 2, 3)], [...plainGen(1)]);
async function plainAsync(a: number, ...r: number[]) { return [a, r]; }
plainAsync(1, 2, 3).then((v) => console.log(v));
const gv: any = plainGen, av: any = plainAsync;
console.log([...gv(4, 5)]);
av(6, 7, 8).then((v: any) => console.log(v));
async function* plainAsyncGen(...r: number[]) { yield r; }
plainAsyncGen(1, 2).next().then((v) => console.log(v));
function* withArguments(a: number, ...r: number[]) { yield arguments.length; yield r.length; }
console.log([...withArguments(1, 2, 3)]);
function* builds(...r: string[]) { yield r.map((s) => s + "!").join(); }
console.log(builds("a" + 1, "b" + 2, "c" + 3).next().value);
const big: string[] = []; for (let i = 0; i < 2000; i++) big.push("s" + i);
async function many(...r: string[]) { return r.length + r[1999]; }
many(...big).then(console.log);
